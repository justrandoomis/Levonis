/**
 * «الهوية» — the brand kit as the owner reads and edits it (spec §5, §6).
 *
 * BINDING RULES are listed, in three languages, and cannot be switched off:
 * the app enforces them everywhere. PREFERENCES (colours, type sizes, the
 * logo’s corner and width, digits, tone, notes) are edited here by the owner
 * and saved as a NEW version (POST /brand/versions) through the same gate the
 * server uses (`normalizeBrandKit`); a design keeps the version it was made
 * with. Approving a version is the owner’s too. Everyone else reads.
 *
 * The FORM says which kit it shows. After a save it stays on what was saved
 * (the kit in force is still the last APPROVED one, so re-reading it would
 * snap the form back); any version can be opened in the form before it is
 * approved (GET /brand/versions/:version — a Worker without that route says
 * so instead of failing). The logo is the site's own or an APPROVED logo
 * asset, picked here.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import { BINDING_RULES, TYPE_ROLES, normalizeBrandKit, type BrandKit, type TypeRole } from '../../../packages/creativeDoc/src/brand';
import { FONT_REGISTRY, isHexColor, type FontFamilyId } from '../../../packages/creativeDoc/src/schema';
import { assets as assetsApi, brand as brandApi } from './client';
import { COLOR_KEY_TEXT, CORNER_TEXT, FONT_ROLE_TEXT, ROLE_TEXT, S, fill } from './strings';
import { RemoteView, failText, shortTime, useRemote, useStudio, useText } from './shared';

const COLOR_KEYS = ['background', 'surface', 'text', 'text_muted', 'accent', 'accent_text', 'price'] as const;
const roleName = (r: TypeRole) => (r === 'note' ? 'price_note' : r);

export default function BrandTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [versions, reloadVersions] = useRemote(() => brandApi.versions(), []);
  const [bgAssets] = useRemote(() => assetsApi.list('background'), []);
  const [logoAssets] = useRemote(() => assetsApi.list('logo'), []);
  // The version the form shows when it is not the kit in force: just saved, or opened from the list.
  const [pinned, setPinned] = useState<{ version: number; status: 'pending' | 'approved' } | null>(null);
  const brand = studio.brand;
  const owner = studio.user.isOwner;
  const [kit, setKit] = useState<BrandKit | null>(brand?.kit ?? null);
  const [note, setNote] = useState('');
  const [newColor, setNewColor] = useState('#');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (pinned === null) setKit(brand?.kit ?? null);
  }, [brand, pinned]);

  if (!brand || !kit) return <p className="p-6 text-sm text-text-muted" role="status">{w(S.loading)}</p>;

  const set = (patch: Partial<BrandKit>) => setKit({ ...kit, ...patch });
  const save = async () => {
    setMessage(null);
    const n = normalizeBrandKit(kit);
    if (!n.ok) {
      setMessage({ tone: 'error', text: n.issues.map((i) => `${i.path} ${i.code}`).join('، ') });
      return;
    }
    try {
      const saved = await brandApi.saveVersion(n.kit, note.trim().slice(0, 300));
      setNote('');
      // The form stays on what was saved; the kit in force is re-read for everything else.
      setKit(n.kit);
      if (saved) {
        setPinned({ version: saved.version, status: saved.status });
        setMessage({ tone: 'ok', text: fill(w(S.brandSavedPending), { n: saved.version }) });
      } else {
        setMessage({ tone: 'ok', text: w(S.brandSaved) });
      }
      studio.reloadBrand();
      reloadVersions();
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };
  const approve = async (version: number) => {
    setMessage(null);
    try {
      await brandApi.approve(version);
      setPinned(null);
      setMessage({ tone: 'ok', text: w(S.brandApproved) });
      studio.reloadBrand();
      reloadVersions();
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };
  const view = async (version: number) => {
    setMessage(null);
    try {
      const v = await brandApi.version(version);
      setKit(v.kit);
      setPinned({ version: v.version.version, status: v.version.status });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiError && e.status === 404 ? w(S.brandViewUnavailable) : failText(e, lang) });
    }
  };
  const status = brand.status === 'approved' ? S.brandVersionApproved : brand.status === 'pending' ? S.brandVersionPending : S.brandVersionDefault;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-brand-tab>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-text-primary">{kit.name}</h1>
        <StatusChip tone={brand.status === 'approved' ? 'success' : 'warning'}>{w(status)}{brand.version ? ` · v${brand.version}` : ''}</StatusChip>
      </div>
      {!owner ? <p className="text-sm text-text-muted">{w(S.brandOwnerOnly)}</p> : null}
      <div className="flex flex-wrap items-center gap-2" role="status" data-brand-form-shows={pinned ? pinned.version : 'current'}>
        <p className="text-sm text-text-secondary">
          {pinned ? fill(w(S.brandFormShows), { n: pinned.version, status: w(pinned.status === 'approved' ? S.brandVersionApproved : S.brandVersionPending) }) : w(S.brandFormCurrent)}
        </p>
        {pinned ? <Button size="sm" variant="ghost" onClick={() => setPinned(null)}>{w(S.brandBackToCurrent)}</Button> : null}
      </div>

      <Card title={w(S.brandRules)}>
        <ul className="flex flex-col gap-2" data-binding-rules>
          {BINDING_RULES.map((r) => <li key={r.code} className="text-sm text-text-primary">• {r[lang]}</li>)}
        </ul>
      </Card>

      <Card title={w(S.brandPrefs)}>
        <fieldset disabled={!owner} className="flex flex-col gap-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">{w(S.brandColors)}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {COLOR_KEYS.map((k) => (
                <Field key={k} label={w(COLOR_KEY_TEXT[k])} error={isHexColor(kit.colors[k]) ? undefined : w(S.brandInvalidHex)}>
                  <div className="flex items-center gap-2">
                    <span aria-hidden="true" className="h-9 w-9 shrink-0 rounded-lg" style={{ background: isHexColor(kit.colors[k]) ? kit.colors[k] : 'transparent', boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.5)' }} />
                    <Input ltr value={kit.colors[k]} maxLength={7} onChange={(e) => set({ colors: { ...kit.colors, [k]: e.target.value.trim().toLowerCase() } })} />
                  </div>
                </Field>
              ))}
            </div>
            <h4 className="mb-1 mt-3 text-[13px] font-semibold text-text-secondary">{w(S.brandPalette)}</h4>
            <div className="flex flex-wrap items-center gap-1.5">
              {kit.colors.palette.map((hex) => (
                <button key={hex} type="button" title={hex} aria-label={`${w(S.remove)} ${hex}`} className="h-11 w-11 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" style={{ background: hex, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.5)' }} onClick={() => set({ colors: { ...kit.colors, palette: kit.colors.palette.filter((x) => x !== hex) } })} />
              ))}
              <Input ltr className="w-28" value={newColor} maxLength={7} aria-label={w(S.brandAddColor)} onChange={(e) => setNewColor(e.target.value.trim().toLowerCase())} />
              <Button size="sm" disabled={!isHexColor(newColor)} onClick={() => { set({ colors: { ...kit.colors, palette: [...new Set([...kit.colors.palette, newColor])] } }); setNewColor('#'); }}>{w(S.brandAddColor)}</Button>
            </div>
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <h3 className="text-sm font-semibold text-text-primary sm:col-span-2">{w(S.brandFonts)}</h3>
            {(['primary', 'display'] as const).map((k) => (
              <Field key={k} label={w(FONT_ROLE_TEXT[k])}>
                <Select value={kit.fonts[k]} onChange={(e) => set({ fonts: { ...kit.fonts, [k]: e.target.value as FontFamilyId } })}>
                  {Object.values(FONT_REGISTRY).filter((f) => !f.latinOnly).map((f) => <option key={f.id} value={f.id}>{f.family}</option>)}
                </Select>
              </Field>
            ))}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-text-primary">{w(S.brandTypeScale)}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {TYPE_ROLES.map((r) => (
                <div key={r} className="grid grid-cols-2 gap-2 rounded-lg border border-border-subtle p-2">
                  <p className="col-span-2 text-xs font-semibold text-text-secondary">{w(ROLE_TEXT[roleName(r)])}</p>
                  <Field label={w(S.brandSize)}><Input type="number" ltr value={kit.type[r].size} onChange={(e) => set({ type: { ...kit.type, [r]: { ...kit.type[r], size: Number(e.target.value) } } })} /></Field>
                  <Field label={w(S.brandFloor)}><Input type="number" ltr value={kit.type[r].min} onChange={(e) => set({ type: { ...kit.type, [r]: { ...kit.type[r], min: Number(e.target.value) } } })} /></Field>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-2 sm:grid-cols-3">
            <h3 className="text-sm font-semibold text-text-primary sm:col-span-3">{w(S.brandLogo)}</h3>
            <Field label={w(S.brandLogoPick)} hint={w(S.brandLogoPickHint)} className="sm:col-span-3">
              <Select value={kit.logo.asset} onChange={(e) => set({ logo: { ...kit.logo, asset: e.target.value } })} data-logo-pick>
                <option value="site">{w(S.brandLogoSite)}</option>
                {logoAssets.status === 'ready'
                  ? logoAssets.data.filter((a) => a.review === 'approved').map((a) => <option key={a.id} value={a.id}>{a.label || a.id}</option>)
                  : null}
                {kit.logo.asset !== 'site' && !(logoAssets.status === 'ready' && logoAssets.data.some((a) => a.id === kit.logo.asset && a.review === 'approved'))
                  ? <option value={kit.logo.asset}>{kit.logo.asset}</option>
                  : null}
              </Select>
            </Field>
            <Field label={w(S.brandLogoWidth)}><Input type="number" ltr value={kit.logo.width} onChange={(e) => set({ logo: { ...kit.logo, width: Number(e.target.value) } })} /></Field>
            <Field label={w(S.brandLogoCorner)}>
              <Select value={kit.logo.corner} onChange={(e) => set({ logo: { ...kit.logo, corner: e.target.value as BrandKit['logo']['corner'] } })}>
                {(['top_start', 'top_end', 'bottom_start', 'bottom_end'] as const).map((c) => <option key={c} value={c}>{w(CORNER_TEXT[c])}</option>)}
              </Select>
            </Field>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
              <p className="text-xs text-text-muted">{w(S.brandUploadHint)}</p>
              <Button size="sm" variant="ghost" onClick={() => studio.goTab('assets')}>{w(S.tabAssets)}</Button>
            </div>
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <Field label={w(S.brandDigits)}>
              <Select value={kit.digits} onChange={(e) => set({ digits: e.target.value === 'arab' ? 'arab' : 'latn' })}>
                <option value="latn">{w(S.brandDigitsLatn)}</option>
                <option value="arab">{w(S.brandDigitsArab)}</option>
              </Select>
            </Field>
            <Field label={w(S.brandCurrency)}>
              <Select value={kit.currency_label} onChange={(e) => set({ currency_label: e.target.value === 'IQD' ? 'IQD' : 'د.ع' })}>
                <option value="د.ع">د.ع</option>
                <option value="IQD">IQD</option>
              </Select>
            </Field>
            <Field label={w(S.assetsBackgrounds)}>
              <Select value={kit.default_background} onChange={(e) => set({ default_background: e.target.value })}>
                {kit.backgrounds.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </Select>
            </Field>
            <RemoteView remote={bgAssets} onRetry={() => undefined} compact>
              {(list) => (
                <div className="flex flex-wrap gap-2">
                  {list.filter((a) => a.review === 'approved' && !kit.backgrounds.some((b) => b.asset_id === a.id)).map((a) => (
                    <Button key={a.id} size="sm" onClick={() => set({ backgrounds: [...kit.backgrounds, { id: `bg_${a.id.slice(0, 20).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`, label: a.label || a.id, kind: 'asset', color: kit.colors.background, asset_id: a.id }] })}>
                      + {a.label || a.id}
                    </Button>
                  ))}
                </div>
              )}
            </RemoteView>
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <Field label={w(S.brandNotes)}><Textarea rows={4} value={kit.notes.join('\n')} onChange={(e) => set({ notes: e.target.value.split('\n') })} /></Field>
            <Field label={w(S.brandAvoid)}><Textarea rows={4} value={kit.avoid.join('\n')} onChange={(e) => set({ avoid: e.target.value.split('\n') })} /></Field>
          </section>

          {owner ? (
            <section className="flex flex-col gap-2">
              <Field label={w(S.brandVersionNote)}><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
              <Button variant="primary" onClick={save}>{w(S.brandSaveVersion)}</Button>
            </section>
          ) : null}
        </fieldset>
        {message ? <p className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
      </Card>

      <Card title={w(S.brandVersions)}>
        <RemoteView remote={versions} onRetry={reloadVersions} compact>
          {(list) => list.length === 0 ? <p className="text-sm text-text-muted">{w(S.brandVersionDefault)}</p> : (
            <ul className="flex flex-col gap-2">
              {list.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle p-2">
                  <span className="text-sm font-semibold text-text-primary">v{v.version}</span>
                  <StatusChip tone={v.status === 'approved' ? 'success' : 'warning'}>{w(v.status === 'approved' ? S.brandVersionApproved : S.brandVersionPending)}</StatusChip>
                  <span className="min-w-0 flex-1 text-xs text-text-muted">{v.note} · {shortTime(v.created_at, lang)}{v.created_by_name ? ` · ${v.created_by_name}` : ''}</span>
                  <Button size="sm" variant="ghost" onClick={() => view(v.version)} data-brand-view={v.version}>{w(S.brandView)}</Button>
                  {owner && v.status === 'pending' ? <Button size="sm" onClick={() => approve(v.version)}>{w(S.brandApprove)}</Button> : null}
                </li>
              ))}
            </ul>
          )}
        </RemoteView>
      </Card>
    </div>
  );
}
