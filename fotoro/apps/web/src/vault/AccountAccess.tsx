export function AccountAccess({ password, onPassword, generatedPassword, busy, onSignIn, onPasskey, onCreate, onContinue, onBack, onCopy, onSave }: {
  password: string;
  onPassword: (password: string) => void;
  generatedPassword: string;
  busy: boolean;
  onSignIn: () => void;
  onPasskey?: () => void;
  onCreate: () => void;
  onContinue: () => void;
  onBack: () => void;
  onCopy: () => void;
  onSave: () => void;
}) {
  if (generatedPassword) return <form className="account-access" aria-busy={busy} onSubmit={event => {event.preventDefault(); if (!busy) onContinue();}}>
    <h2>Start your Fotoro</h2>
    <p className="account-password-note">Keep this password to open your photos on another device.</p>
    <label className="account-field">
      <span>Fotoro password</span>
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
    <form className="account-access" aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (!busy && password.trim()) onSignIn();
    }}>
      <h2>Sign in</h2>
      <label className="account-field">
        <span>Fotoro password</span>
        <input name="password" type="password" placeholder="Fotoro password" autoComplete="current-password" value={password} onChange={event => onPassword(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
      </label>
      <button className="primary-action" type="submit" disabled={busy || !password.trim()}>Open Fotoro</button>
    </form>
    {onPasskey && <button className="text-button" disabled={busy} onClick={onPasskey}>Use a passkey</button>}
    <button className="text-button account-create" disabled={busy} onClick={onCreate}>New Fotoro</button>
  </>;
}
