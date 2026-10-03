export function AccountAccess({ password, onPassword, generatedPassword, busy, onSignIn, onCreate, onContinue, onBack, onCopy, onSave }: {
  password: string;
  onPassword: (password: string) => void;
  generatedPassword: string;
  busy: boolean;
  onSignIn: () => void;
  onCreate: () => void;
  onContinue: () => void;
  onBack: () => void;
  onCopy: () => void;
  onSave: () => void;
}) {
  if (generatedPassword) return <form aria-busy={busy} onSubmit={event => {event.preventDefault(); if (!busy) onContinue();}}>
    <p className="hint">Save your password to open Fotoro on another device.</p>
    <label>
      Fotoro password
      <input name="password" type="text" autoComplete="new-password" value={generatedPassword} readOnly onFocus={event => event.currentTarget.select()} enterKeyHint="go" />
    </label>
    <div className="header-actions">
      <button type="button" disabled={busy} onClick={onCopy}>Copy</button>
      <button type="button" disabled={busy} onClick={onSave}>Save password</button>
    </div>
    <button className="primary-action" type="submit" disabled={busy}>Open Fotoro</button>
    <button className="text-button" type="button" disabled={busy} onClick={onBack}>Back</button>
  </form>;
  return <>
    <form aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (!busy && password.trim()) onSignIn();
    }}>
      <label>
        Fotoro password
        <input name="password" type="password" autoComplete="current-password" value={password} onChange={event => onPassword(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
      </label>
      <button className="primary-action" type="submit" disabled={busy || !password.trim()}>Open Fotoro</button>
    </form>
    <button disabled={busy} onClick={onCreate}>New Fotoro</button>
  </>;
}
