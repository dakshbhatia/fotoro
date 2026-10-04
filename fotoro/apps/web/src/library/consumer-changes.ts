export interface ConsumerPhotoChanges {
  token: object;
  accountId: string;
  current: () => boolean;
  pending: readonly {photoId: string; originalSha256: string; conflict: boolean}[];
  busy: boolean;
  error: string;
  errorSource?: {photoId: string; originalSha256: string};
  save: () => Promise<boolean>;
  review: () => void;
}

export function photoChangeState(changes: ConsumerPhotoChanges | undefined, photoId: string, originalSha256: string, ownerAccountId: string) {
  if (!changes?.current() || changes.accountId !== ownerAccountId) return {pending: false, conflict: false, busy: false, error: ""};
  const pending = changes?.pending.find(edit => edit.photoId === photoId && edit.originalSha256 === originalSha256);
  const source = changes?.errorSource;
  const error = source ? source.photoId === photoId && source.originalSha256 === originalSha256 : !!pending;
  return {pending: !!pending, conflict: pending?.conflict === true, busy: changes?.busy === true, error: error ? changes?.error ?? "" : ""};
}
