/**
 * o2steam: the element a "..." menu should open next to.
 *
 * Steam's DialogButton hands its onClick an event whose currentTarget is already empty, and
 * showContextMenu(menu, window) puts the menu in the top-left corner of the window. So we use the
 * clicked element (the button around it if an icon inside was hit), and only then fall back.
 */
export function menuAnchor(event?: { currentTarget?: any; target?: any } | null): any {
	const current = event?.currentTarget;
	if (current && typeof current.getBoundingClientRect === 'function') return current;

	const target = event?.target as Element | undefined;
	if (target && typeof target.getBoundingClientRect === 'function') {
		return target.closest?.('.MillenniumIconButton, button, .DialogButton') ?? target;
	}

	const active = document.activeElement;
	if (active && active !== document.body && typeof (active as Element).getBoundingClientRect === 'function') return active;

	return window;
}
