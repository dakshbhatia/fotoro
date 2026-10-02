export function AccountAccess({ password, onPassword, generatedPassword, busy, onSignIn, onCreate, onContinue, onBack, onPasskey, onCopy, onSave }: {
  password: string;
  onPassword: (password: string) => void;
  generatedPassword: string;
  busy: boolean;
  onSignIn: () => void;
  onCreate: () => void;
  onContinue: () => void;
  onBack: () => void;
  onPasskey: () => void;
  onCopy: () => void;
  onSave: () => void;
}) {
  if (generatedPassword) return <form onSubmit={event => {event.preventDefault(); if (!busy) onContinue();}}>
    <h3>Your Fotoro password</h3>
    <p className="hint">Save this password to use Fotoro on another device. It is the only password you need.</p>
    <label>
      Fotoro password
      <input name="password" type="text" autoComplete="new-password" value={generatedPassword} readOnly onFocus={event => event.currentTarget.select()} />
    </label>
    <div className="header-actions">
      <button type="button" disabled={busy} onClick={onCopy}>Copy password</button>
      <button type="button" disabled={busy} onClick={onSave}>Save password</button>
    </div>
    <button className="primary-action" type="submit" disabled={busy}>Continue</button>
    <button className="text-button" type="button" disabled={busy} onClick={onBack}>Back to sign in</button>
  </form>;
  return <>
    <form onSubmit={event => {
      event.preventDefault();
      if (!busy && password.trim()) onSignIn();
    }}>
      <label>
        Fotoro password
        <input name="password" type="password" autoComplete="current-password" value={password} onChange={event => onPassword(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <button className="primary-action" type="submit" disabled={busy || !password.trim()}>Sign in</button>
    </form>
    <button disabled={busy} onClick={onCreate}>Create account</button>
    <details>
      <summary>Other ways to sign in</summary>
      <button disabled={busy} onClick={onPasskey}>Use an existing passkey</button>
    </details>
  </>;
}
