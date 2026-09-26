/**
 * Copy a string to the clipboard, including inside in-app WebViews
 * (Instagram, Messenger…) where `navigator.clipboard` is often missing or
 * rejects. Falls back to a temporary <textarea> + execCommand('copy'). Returns
 * whether the copy is believed to have succeeded — callers still show the text
 * itself (selectable) so a failure is never a dead end.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.insetInlineStart = '0';
    ta.style.opacity = '0';
    ta.style.fontSize = '16px'; // no iOS zoom on focus
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
