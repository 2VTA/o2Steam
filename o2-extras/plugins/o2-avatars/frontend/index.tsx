/**
 * o2steam Avatars
 *
 * Swaps avatar pictures inside Steam for ones from two places:
 *   - the registry: https://raw.githubusercontent.com/2VTA/o2steam-registry/main/avatars.json
 *     { "avatars": { "<steamid64>": "https://.../picture.gif" } }
 *     Everyone running this plugin sees the pictures listed there (GIFs animate).
 *   - the viewer's own choice (URL or file), shown on their own avatar straight away.
 *
 * Steam only gives us an avatar's hash in the page, so we work out hash -> steamid from the friend store
 * (every friend + yourself) and replace <img> / inline background images that use that hash.
 */

declare const g_PopupManager: any;

const REGISTRY_URL = 'https://raw.githubusercontent.com/2VTA/o2steam-registry/main/avatars.json';
const STORAGE_KEY = 'o2steam-avatars.v1';
const STEAMID64_BASE = 76561197960265728n;
const HASH_RE = /([0-9a-f]{40})(?:_(?:full|medium))?\.(?:jpe?g|png|gif)/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Saved {
	mine: string; // https url or data: url, shown on the viewer's own avatar
}

const state = {
	saved: { mine: '' } as Saved,
	registry: {} as Record<string, string>,
	registryStatus: 'not loaded yet',
	hashToUrl: new Map<string, string>(),
	selfSteamId: '',
	mapSignature: '',
	mapChanged: false,
	listeners: new Set<() => void>(),
};

const W = window as any;

function loadSaved() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) state.saved = { mine: '', ...JSON.parse(raw) };
	} catch {}
}

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved));
	} catch {}
}

function notify() {
	state.listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- share-page links -> the real image
// People paste the page they copied from (tenor.com/view/..., giphy.com/gifs/...), which is a web page,
// not an image, so nothing would show. Turn those into the direct GIF.

/** media1.tenor.com/m/<id>/<name>.gif answers 404 outside a browser tab; media.tenor.com/<id>/<name>.gif works */
function tenorMediaUrl(url: string): string {
	return url.replace(/^https:\/\/media\d*\.tenor\.com\/m\//i, 'https://media.tenor.com/');
}

async function resolveImageLink(url: string): Promise<string> {
	const giphy = /^https:\/\/(?:www\.)?giphy\.com\/gifs\/(?:[^/?#]*-)?([A-Za-z0-9]+)(?:[/?#]|$)/i.exec(url);
	if (giphy) return `https://media.giphy.com/media/${giphy[1]}/giphy.gif`;

	if (/^https:\/\/media\d*\.tenor\.com\/m\//i.test(url)) return tenorMediaUrl(url);

	if (/^https:\/\/(?:www\.)?tenor\.com\/(?:[a-z-]+\/)?view\//i.test(url)) {
		// tenor's page has no CORS headers, so o2steam's core reads it (it only allows tenor.com/view/ pages)
		const page = url.replace(/^https:\/\/(?:www\.)?tenor\.com\/(?:[a-z-]+\/)?view\//i, 'https://tenor.com/view/').split(/[?#]/)[0];
		const result: any = await W.MILLENNIUM_API.ffi('core', 'Core_FetchStoreJson')(page);
		const html: string = result?.success ? String(result.body ?? '') : '';
		const og = /property="og:image"\s+content="([^"]+)"/i.exec(html) ?? /content="([^"]+)"\s+property="og:image"/i.exec(html);
		if (!og) throw new Error('Could not read that Tenor link.');
		return tenorMediaUrl(og[1]);
	}
	return url;
}

/** resolves after the browser actually decoded the image, so a page link or a dead link is caught */
function checkImageLoads(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		const img = new Image();
		const timer = setTimeout(() => resolve(false), 15000);
		img.onload = () => {
			clearTimeout(timer);
			resolve(img.naturalWidth > 0);
		};
		img.onerror = () => {
			clearTimeout(timer);
			resolve(false);
		};
		img.src = url;
	});
}

function isSafeImage(url: unknown): url is string {
	return typeof url === 'string' && (/^https:\/\//i.test(url) || /^data:image\/(gif|png|jpeg|webp);base64,/i.test(url));
}

// ---------------------------------------------------------------- hash -> steamid -> picture

function accountToSteamId(account: number | string): string {
	try {
		return (STEAMID64_BASE + BigInt(account)).toString();
	} catch {
		return '';
	}
}

function rebuildHashMap() {
	const store = W.friendStore;
	if (!store) return;

	try {
		state.selfSteamId = store.m_CMInterface?.steamid?.ConvertTo64BitString?.() ?? state.selfSteamId;
	} catch {}

	const next = new Map<string, string>();
	const cache: Map<any, any> | undefined = store.m_mapPlayerCache;
	if (cache && typeof cache.forEach === 'function') {
		cache.forEach((player: any, key: any) => {
			const persona = player?.m_persona ?? player;
			const hash: string | undefined = persona?.m_strAvatarHash;
			if (!hash || hash.length !== 40) return;

			let steamId = '';
			try {
				steamId = persona?.m_steamid?.ConvertTo64BitString?.() ?? '';
			} catch {}
			if (!steamId) steamId = accountToSteamId(player?.m_unAccountID ?? key);

			const url = steamId === state.selfSteamId && isSafeImage(state.saved.mine) ? state.saved.mine : state.registry[steamId];
			if (isSafeImage(url)) next.set(hash.toLowerCase(), url);
		});
	}
	const signature = [...next].map(([h, u]) => h + '=' + u.length + u.slice(-24)).join('|');
	state.mapChanged = signature !== state.mapSignature;
	state.mapSignature = signature;
	state.hashToUrl = next;
}

// ---------------------------------------------------------------- applying to documents

function swapImage(img: HTMLImageElement) {
	const m = HASH_RE.exec(img.currentSrc || img.src || '');
	if (!m) return;
	const url = state.hashToUrl.get(m[1].toLowerCase());
	if (url && img.src !== url) {
		img.dataset.o2avOriginal ??= img.src;
		img.src = url;
	}
}

function swapBackground(el: HTMLElement) {
	const bg = el.style?.backgroundImage;
	if (!bg) return;
	const m = HASH_RE.exec(bg);
	if (!m) return;
	const url = state.hashToUrl.get(m[1].toLowerCase());
	if (url) el.style.backgroundImage = `url("${url}")`;
}

function scan(root: ParentNode) {
	if (!state.hashToUrl.size) return;
	root.querySelectorAll?.('img').forEach((img) => swapImage(img as HTMLImageElement));
	root.querySelectorAll?.('[style*="background"]').forEach((el) => swapBackground(el as HTMLElement));
}

const attached = new WeakSet<Document>();

function attachDocument(doc: Document | undefined | null) {
	// nothing to swap -> don't watch the page at all
	if (!state.hashToUrl.size) return;
	if (!doc || attached.has(doc)) return;
	if (!doc.documentElement) return;
	attached.add(doc);

	const observer = new MutationObserver((records) => {
		if (!state.hashToUrl.size) return;
		for (const r of records) {
			if (r.type === 'attributes') {
				const el = r.target as HTMLElement;
				if (el instanceof (doc.defaultView as any).HTMLImageElement) swapImage(el as HTMLImageElement);
				else swapBackground(el);
			} else {
				r.addedNodes.forEach((n) => {
					if (n.nodeType !== 1) return;
					const el = n as HTMLElement;
					if (el.tagName === 'IMG') swapImage(el as HTMLImageElement);
					else scan(el);
				});
			}
		}
	});
	observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
	scan(doc);
}

function attachPopup(popup: any) {
	try {
		const tryAttach = (tries = 0) => {
			const win = popup?.window ?? popup?.m_popup?.window;
			const doc: Document | undefined = win?.document;
			if (doc?.body) attachDocument(doc);
			else if (tries < 40) setTimeout(() => tryAttach(tries + 1), 250);
		};
		tryAttach();
	} catch {}
}

function rescanAll() {
	try {
		for (const popup of Array.from(g_PopupManager.GetPopups())) {
			const doc: Document | undefined = (popup as any)?.window?.document;
			if (doc?.body) {
				attachDocument(doc);
				scan(doc);
			}
		}
	} catch {}
}

// ---------------------------------------------------------------- registry

async function refreshRegistry() {
	try {
		const res = await fetch(`${REGISTRY_URL}?t=${Date.now()}`, { cache: 'no-store' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		const clean: Record<string, string> = {};
		for (const [id, url] of Object.entries(json?.avatars ?? {})) {
			if (/^\d{17}$/.test(id) && isSafeImage(url) && !String(url).startsWith('data:')) clean[id] = url as string;
		}
		state.registry = clean;
		state.registryStatus = `${Object.keys(clean).length} avatar(s) in the registry`;
	} catch (e: any) {
		state.registryStatus = `registry not reachable (${e?.message ?? e})`;
	}
	rebuildHashMap();
	rescanAll();
	notify();
}

// ---------------------------------------------------------------- settings panel (no JSX: Steam's React is used directly)

function Panel() {
	const React = W.SP_REACT;
	const { DialogButton, TextField, Field, PanelSection, PanelSectionRow } = W.MILLENNIUM_API;
	const [, force] = React.useReducer((x: number) => x + 1, 0);
	const [draft, setDraft] = React.useState(state.saved.mine.startsWith('data:') ? '' : state.saved.mine);
	const [message, setMessage] = React.useState('');

	React.useEffect(() => {
		state.listeners.add(force);
		return () => {
			state.listeners.delete(force);
		};
	}, []);

	const apply = (value: string) => {
		state.saved.mine = value;
		persist();
		rebuildHashMap();
		rescanAll();
		force();
	};

	const useLink = async () => {
		const url = draft.trim();
		if (!url) return apply('');
		if (!/^https:\/\//i.test(url)) return setMessage('Use an https:// link to an image or GIF.');
		setMessage('Checking the link...');
		try {
			const direct = await resolveImageLink(url);
			if (!(await checkImageLoads(direct))) return setMessage("That link doesn't open as an image. Use a direct image/GIF link (Tenor and Giphy page links are converted for you).");
			setDraft(direct);
			setMessage(direct !== url ? 'Converted to the direct GIF link and applied.' : 'Applied.');
			apply(direct);
		} catch (e: any) {
			setMessage(String(e?.message ?? e));
		}
	};

	const pickFile = () => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/gif,image/png,image/jpeg,image/webp';
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			if (file.size > MAX_FILE_BYTES) return setMessage('That file is over 2 MB. Pick a smaller one or use a link.');
			const reader = new FileReader();
			reader.onload = () => {
				setMessage('Only you will see a picked file. To show it to everyone, upload it somewhere and use the link instead.');
				apply(String(reader.result));
			};
			reader.readAsDataURL(file);
		};
		input.click();
	};

	const copyEntry = () => {
		const url = state.saved.mine;
		if (!state.selfSteamId || !/^https:\/\//i.test(url)) return setMessage('Set an https:// link first, then copy your entry.');
		const line = `"${state.selfSteamId}": "${url}"`;
		try {
			navigator.clipboard.writeText(line);
			setMessage('Copied. Send it to Ryder to be added to the registry so everyone sees it.');
		} catch {
			setMessage(line);
		}
	};

	const h = React.createElement;
	const mine = state.saved.mine;
	return h(
		PanelSection,
		{ title: 'o2steam Avatars' },
		h(PanelSectionRow, null, h('div', { style: { fontSize: 12, opacity: 0.8 } }, `Registry: ${state.registryStatus}`)),
		mine ? h(PanelSectionRow, null, h('img', { src: mine, style: { width: 96, height: 96, borderRadius: 6, objectFit: 'cover' } })) : null,
		h(Field, { label: 'Image / GIF link' }, h(TextField, { value: draft, placeholder: 'https://.../me.gif', onChange: (e: any) => setDraft(e.target.value) })),
		h(PanelSectionRow, null, h(DialogButton, { onClick: useLink }, 'Use this link')),
		h(PanelSectionRow, null, h(DialogButton, { onClick: pickFile }, 'Pick a file (only you see it)')),
		h(PanelSectionRow, null, h(DialogButton, { onClick: copyEntry }, 'Copy my registry entry')),
		mine ? h(PanelSectionRow, null, h(DialogButton, { onClick: () => { setDraft(''); setMessage(''); apply(''); } }, 'Remove my custom avatar')) : null,
		message ? h(PanelSectionRow, null, h('div', { style: { fontSize: 12 } }, message)) : null,
	);
}

/** a page link saved by an older version (e.g. tenor.com/view/...) is turned into the direct image once */
async function repairSavedLink() {
	const mine = state.saved.mine;
	if (!mine || mine.startsWith('data:')) return;
	try {
		const direct = await resolveImageLink(mine);
		if (direct !== mine && (await checkImageLoads(direct))) {
			state.saved.mine = direct;
			persist();
			rebuildHashMap();
			rescanAll();
			notify();
		}
	} catch {}
}

export default async function PluginMain() {
	loadSaved();
	rebuildHashMap();
	void repairSavedLink();

	try {
		Array.from(g_PopupManager.GetPopups()).forEach(attachPopup);
		g_PopupManager.AddPopupCreatedCallback(attachPopup);
	} catch {}

	refreshRegistry();
	setInterval(refreshRegistry, 10 * 60 * 1000);
	// friends load their personas a little after start, and people change avatars: look again now and
	// then, but only touch the pages when the list of swapped avatars actually changed
	setInterval(() => {
		rebuildHashMap();
		if (state.mapChanged && state.hashToUrl.size) rescanAll();
	}, 15000);

	return {
		title: 'o2steam Avatars',
		icon: W.SP_REACT.createElement('span', null, 'o2'),
		content: W.SP_REACT.createElement(Panel),
	};
}
