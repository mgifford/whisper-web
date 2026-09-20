import React, { useEffect, useRef, useState } from "react";
import Modal from "./modal/Modal";
import { UrlInput } from "./modal/UrlInput";
import { isPrivateOrLocalHost } from "../utils/AudioUtils";

const INVALID_URL_FORMAT = "INVALID_URL_FORMAT";
const INVALID_URL_SCHEME = "INVALID_URL_SCHEME";
const INVALID_PRIVATE_URL = "INVALID_PRIVATE_URL";
const FEED_TOO_LARGE = "FEED_TOO_LARGE";
const NO_FEED_FOUND = "NO_FEED_FOUND";
const NOT_A_FEED = "NOT_A_FEED";
const NO_AUDIO_EPISODES = "NO_AUDIO_EPISODES";
const MAX_FEED_BYTES = 15 * 1024 * 1024; // 15 MB safety cap for feeds/pages

export interface RssEpisode {
    url: string;
    title: string;
    pubDate?: string;
}

export interface RssModalProps {
    show: boolean;
    onSubmit: (url: string, title?: string) => void;
    onClose: () => void;
}

function validateFeedUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        throw new Error(INVALID_URL_FORMAT);
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(trimmed);
    } catch {
        throw new Error(INVALID_URL_FORMAT);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(INVALID_URL_SCHEME);
    }

    if (parsedUrl.origin !== window.location.origin) {
        if (isPrivateOrLocalHost(parsedUrl.hostname)) {
            throw new Error(INVALID_PRIVATE_URL);
        }
    }

    return parsedUrl;
}

async function readBodyText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        return response.text();
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_FEED_BYTES) {
            throw new Error(FEED_TOO_LARGE);
        }
        chunks.push(value);
    }

    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
}

function looksLikeHtml(text: string): boolean {
    return /<html[^>]*>/i.test(text) || /<!doctype html>/i.test(text);
}

function isXmlError(parsed: Document): boolean {
    return parsed.getElementsByTagName("parsererror").length > 0;
}

function getAttribute(element: Element, attribute: string): string | undefined {
    const value = element.getAttribute(attribute);
    return value ? value.trim() : undefined;
}

// Extracts the first audio enclosure or audio media:content from a feed item.
function getItemAudioUrl(item: Element): string | undefined {
    const enclosures = item.getElementsByTagName("enclosure");
    for (const enclosure of Array.from(enclosures)) {
        const url = getAttribute(enclosure, "url");
        if (!url) continue;
        const type = (getAttribute(enclosure, "type") || "").toLowerCase();
        if (
            type &&
            !type.startsWith("audio/") &&
            type !== "application/octet-stream"
        ) {
            continue;
        }
        return url;
    }

    const mediaContents = item.getElementsByTagName("media:content");
    for (const media of Array.from(mediaContents)) {
        if ((getAttribute(media, "medium") || "").toLowerCase() !== "audio")
            continue;
        const url = getAttribute(media, "url");
        if (url) return url;
    }

    return undefined;
}

function parseFeed(text: string, feedUrl: string): RssEpisode[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "application/xml");

    if (isXmlError(doc)) {
        throw new Error(NOT_A_FEED);
    }

    const baseHref = feedUrl;
    const episodes: RssEpisode[] = [];
    const seen = new Set<string>();

    for (const item of Array.from(doc.getElementsByTagName("item"))) {
        const rawUrl = getItemAudioUrl(item);
        if (!rawUrl) continue;

        let resolved: string;
        try {
            resolved = new URL(rawUrl, baseHref).href;
        } catch {
            continue;
        }
        const parsedResolved = new URL(resolved);
        if (
            parsedResolved.protocol !== "http:" &&
            parsedResolved.protocol !== "https:"
        ) {
            continue;
        }
        if (seen.has(parsedResolved.href)) continue;
        seen.add(parsedResolved.href);

        const rawTitle = item
            .getElementsByTagName("title")[0]
            ?.textContent?.trim();
        const title = rawTitle || `Episode ${episodes.length + 1}`;
        const rawPubDate = item
            .getElementsByTagName("pubDate")[0]
            ?.textContent?.trim();
        const pubDate = rawPubDate ? formatDate(rawPubDate) : undefined;

        episodes.push({ url: resolved, title, pubDate });
    }

    if (episodes.length === 0) {
        throw new Error(NO_AUDIO_EPISODES);
    }

    return episodes;
}

function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

// Finds the podcast RSS/Atom feed a web page points at via <link rel="alternate">.
function findFeedLinkFromPage(text: string, pageUrl: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");
    const candidates = Array.from(
        doc.querySelectorAll<HTMLLinkElement>(
            'link[rel~="alternate"][type="application/rss+xml"], link[rel~="alternate"][type="application/atom+xml"], link[type="application/rss+xml"], link[type="application/atom+xml"]',
        ),
    );

    const rss = candidates.find((link) => (link.type || "").includes("rss"));
    const chosen = rss || candidates[0];
    const href = chosen && chosen.href;
    if (!href) {
        throw new Error(NO_FEED_FOUND);
    }
    return new URL(href, pageUrl).href;
}

function getFeedErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        if (error.name === "AbortError") {
            return "";
        }
        if (error.message === INVALID_URL_FORMAT) {
            return "Please enter a valid, complete URL including http:// or https:// (e.g., https://example.com/feed.xml).";
        }
        if (error.message === INVALID_URL_SCHEME) {
            return "Only HTTP and HTTPS URLs are supported (e.g., https://example.com/feed.xml).";
        }
        if (error.message === INVALID_PRIVATE_URL) {
            return "Local and private network URLs (such as localhost or internal IP addresses) cannot be accessed.";
        }
        if (error.message === FEED_TOO_LARGE) {
            return "That feed or page is too large to process in the browser.";
        }
        if (error.message === NO_FEED_FOUND) {
            return "That page does not link to a podcast RSS feed, so no episodes could be found.";
        }
        if (error.message === NOT_A_FEED) {
            return "That URL does not appear to be a valid RSS feed or a page linking to one.";
        }
        if (error.message === NO_AUDIO_EPISODES) {
            return "The feed was found, but no episodes with audio files could be found in it.";
        }
        if (error.message === "HTTP_404") {
            return "No feed or page could be found at that URL. Please double-check the link and try again.";
        }
        if (error.message.startsWith("HTTP_")) {
            const status = error.message.replace("HTTP_", "");
            return `Failed to load the feed (server responded with status ${status}).`;
        }
        if (error.name === "TypeError") {
            return "That site blocked the request, so its feed can't be read from a webpage (CORS). Most podcast hosts don't allow other apps to read their feeds directly. You can still transcribe the episode by pasting a direct MP3 link in \"From URL\", or by downloading the MP3 and using \"From file\".";
        }
    }
    return "Something went wrong while loading the feed. Please check the URL and try again.";
}

export default function RssModal(props: RssModalProps) {
    const [inputUrl, setInputUrl] = useState("");
    const [status, setStatus] = useState<
        "idle" | "loading" | "loaded" | "error"
    >("idle");
    const [message, setMessage] = useState<string | null>(null);
    const [feedTitle, setFeedTitle] = useState<string | undefined>(undefined);
    const [resolvedFeedUrl, setResolvedFeedUrl] = useState<string | undefined>(
        undefined,
    );
    const [episodes, setEpisodes] = useState<RssEpisode[]>([]);
    const abortControllerRef = useRef<AbortController | null>(null);

    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();
        };
    }, []);

    const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setInputUrl(event.target.value);
        setStatus("idle");
        setMessage(null);
        setEpisodes([]);
        setFeedTitle(undefined);
        setResolvedFeedUrl(undefined);
    };

    const trim = inputUrl.trim();
    const canSubmit = trim.length > 0 && status !== "loading";

    const parseFeedSource = async (
        rawUrl: string,
        abortController: AbortController,
    ): Promise<{ episodes: RssEpisode[]; title?: string; feedUrl: string }> => {
        const parsed = validateFeedUrl(rawUrl);
        const response = await fetch(parsed.href, {
            signal: abortController.signal,
        });
        if (!response.ok) {
            throw new Error(`HTTP_${response.status}`);
        }
        const text = await readBodyText(response);

        let feedText = text;
        let feedHref = parsed.href;
        let title: string | undefined;

        const contentType = (
            response.headers.get("content-type") || ""
        ).toLowerCase();
        if (contentType.includes("html") || looksLikeHtml(text)) {
            feedHref = findFeedLinkFromPage(text, parsed.href);
            const feedResponse = await fetch(feedHref, {
                signal: abortController.signal,
            });
            if (!feedResponse.ok) {
                throw new Error(`HTTP_${feedResponse.status}`);
            }
            feedText = await readBodyText(feedResponse);
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(feedText, "application/xml");
        if (!isXmlError(doc)) {
            title = doc
                .querySelector("channel > title, feed > title")
                ?.textContent?.trim();
        }

        const parsedEpisodes = parseFeed(feedText, feedHref);
        return { episodes: parsedEpisodes, title, feedUrl: feedHref };
    };

    const onSubmit = async () => {
        if (!canSubmit) return;

        abortControllerRef.current?.abort();
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        setStatus("loading");
        setMessage(null);
        setEpisodes([]);
        setFeedTitle(undefined);
        setResolvedFeedUrl(undefined);

        try {
            const result = await parseFeedSource(trim, abortController);
            setFeedTitle(result.title);
            setResolvedFeedUrl(result.feedUrl);
            setEpisodes(result.episodes);
            setStatus("loaded");
        } catch (error) {
            const errorMessage = getFeedErrorMessage(error);
            if (errorMessage) {
                setMessage(errorMessage);
                setStatus("error");
            }
        }
    };

    const onPickEpisode = (episode: RssEpisode) => {
        props.onSubmit(episode.url, episode.title);
    };

    return (
        <Modal
            show={props.show}
            title='From RSS feed'
            content={
                <div>
                    <p>
                        Paste a podcast RSS feed URL (or a show page that links
                        to one) to see its episodes and pick the one you want to
                        transcribe.
                    </p>
                    <UrlInput
                        label='RSS feed or show page URL'
                        onChange={onChange}
                        value={inputUrl}
                        placeholder='https://example.com/rss/'
                    />
                    {status === "loading" && (
                        <p className='mt-2 text-sm text-slate-600 dark:text-slate-300'>
                            Loading feed…
                        </p>
                    )}
                    {status === "error" && message && (
                        <p className='mt-2 text-xs text-red-700 dark:text-red-300'>
                            {message}
                        </p>
                    )}
                    {status === "loaded" && (
                        <div className='mt-2'>
                            {feedTitle && (
                                <h3 className='rss-feed-title'>{feedTitle}</h3>
                            )}
                            {resolvedFeedUrl && resolvedFeedUrl !== trim && (
                                <p className='rss-feed-note'>
                                    &gt; {resolvedFeedUrl}
                                </p>
                            )}
                            <div
                                className='rss-episodes'
                                role='list'
                                aria-label='Episodes'
                            >
                                {episodes.map((episode) => (
                                    <button
                                        type='button'
                                        key={episode.url}
                                        className='rss-episode'
                                        role='listitem'
                                        onClick={() => onPickEpisode(episode)}
                                    >
                                        <span className='rss-episode__title'>
                                            {episode.title}
                                        </span>
                                        {episode.pubDate && (
                                            <span className='rss-episode__date'>
                                                {episode.pubDate}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            }
            onClose={props.onClose}
            submitText='Find episodes'
            submitEnabled={canSubmit}
            onSubmit={() => {
                void onSubmit();
            }}
        />
    );
}
