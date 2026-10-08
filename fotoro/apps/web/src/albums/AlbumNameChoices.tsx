export function AlbumNameChoices({names, selected, disabled, onChange}: {names: readonly string[]; selected: readonly string[]; disabled?: boolean; onChange: (names: string[]) => void}) {
  return <fieldset disabled={disabled}><legend>Reviewed names</legend><p className="hint">Choose up to 12 names for this photo.</p>{names.length ? names.map(name => <label key={name}><input type="checkbox" checked={selected.includes(name)} disabled={!selected.includes(name) && selected.length >= 12} onChange={event => {
    if (disabled) return;
    if (!event.target.checked) onChange(selected.filter(value => value !== name));
    else if (!selected.includes(name) && selected.length < 12) onChange([...selected, name]);
  }} />{name}</label>) : <p className="hint">No reviewed names available.</p>}</fieldset>;
}
