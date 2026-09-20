import { DetailedHTMLProps, InputHTMLAttributes } from "react";

export function UrlInput({
  label = "URL of audio file",
  ...props
}: DetailedHTMLProps<
  InputHTMLAttributes<HTMLInputElement>,
  HTMLInputElement
> & { label?: string }) {
  return (
    <div>
      <label htmlFor='url-input' className='form-label'>
        {label}
      </label>
      <input
        {...props}
        id='url-input'
        type='url'
        className='url-input'
        placeholder={props.placeholder ?? 'https://example.com/audio.mp3'}
        required
      />
    </div>
  );
}
