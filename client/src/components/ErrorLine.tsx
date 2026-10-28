export function ErrorLine({ message }: { message?: string }) {
  return message ? <p className="err" role="alert">{message}</p> : null;
}
