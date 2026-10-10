import {useEffect, useRef} from "react";
export function AccountAccess({ password, onPassword, generatedPassword, busy, passwordFallback = false, heading, onSignIn, onPasskey, onAnotherAccount, onCreate, onContinue, onBack, onCopy, onSave }: {
  password: string;
  onPassword: (password: string) => void;
  generatedPassword: string;
  busy: boolean;
  passwordFallback?: boolean;
  heading?: string;
  onSignIn: () => void;
  onPasskey?: () => void;
  onAnotherAccount?: () => void;
  onCreate: () => void;
  onContinue: () => void;
  onBack: () => void;
  onCopy: () => void;
  onSave: () => void;
}) {
  const passwordDetails = useRef<HTMLDetailsElement>(null), passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!generatedPassword && passwordFallback && !busy) {
      if (passwordDetails.current) passwordDetails.current.open = true;
      passwordInput.current?.focus();
    }
  }, [passwordFallback, busy, generatedPassword]);
  if (generatedPassword) return <form className="account-access" aria-busy={busy} onSubmit={event => {event.preventDefault(); if (!busy) onContinue();}}>
    <h2>{heading ?? "Start your Fotoro"}</h2>
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
  const passwordForm = <form className="account-access" aria-busy={busy} onSubmit={event => {
      event.preventDefault();
      if (!busy && password.trim()) onSignIn();
    }}>
      <label className="account-field">
        <span>Fotoro password</span>
        <input ref={passwordInput} name="password" type="password" placeholder="Fotoro password" autoComplete="current-password" value={password} onChange={event => onPassword(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
      </label>
      <button className="primary-action" type="submit" disabled={busy || !password.trim()}>Open Fotoro</button>
    </form>;
  return <>
    <h2>{heading ?? "Sign in"}</h2>
    {onPasskey && <button className="primary-action" disabled={busy} onClick={onPasskey}>Continue with a passkey</button>}
    {onAnotherAccount && <button className="text-button" disabled={busy} onClick={onAnotherAccount}>Use another account</button>}
    {onPasskey ? <details ref={passwordDetails} open={passwordFallback || undefined} className="account-password-choice"><summary>Use Fotoro password</summary>{passwordForm}</details> : passwordForm}
    <button className="text-button account-create" disabled={busy} onClick={onCreate}>New Fotoro</button>
  </>;
}
