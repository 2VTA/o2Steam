/**
 * o2steam Avatars - web pages
 *
 * Steam's profile page, comments, friends lists and activity are web pages, so the client-side part of this
 * plugin can't reach them. This part runs on steamcommunity.com pages and swaps the avatar of every person who
 * is in the o2steam registry for their custom picture (GIFs animate), so anyone with o2steam sees it on the
 * full profile too.
 *
 * Steam's pages may not talk to GitHub themselves (their content-security-policy blocks it), so the registry
 * is read by o2steam's core, which only allows the two o2steam addresses it is meant to read.
 */

const W = window as any;
const REGISTRY_URL = 'https://raw.githubusercontent.com/2VTA/o2Steam/main/registry/avatars.json';
const CACHE_KEY = 'o2steam-avatars.registry.v1';
const CACHE_MS = 10 * 60 * 1000;
const STEAMID64_BASE = 76561197960265728n;
const AVATAR_SRC = /^https?:\/\/avatars[.\-]/i;

type Registry = Record<string, string>;

function isSafeImage(url: unknown): url is string {
	return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(url) && url.length < 600;
}

function clean(json: any): Registry {
	const out: Registry = {};
	for (const [id, url] of Object.entries(json?.avatars ?? {})) {
		if (/^\d{17}$/.test(id) && isSafeImage(url)) out[id] = url;
	}
	return out;
}

async function loadRegistry(): Promise<Registry> {
	try {
		const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
		if (cached && Date.now() - cached.t < CACHE_MS) return cached.r;
	} catch {}
	try {
		const result: any = await W.MILLENNIUM_API.ffi('core', 'Core_FetchStoreJson')(`${REGISTRY_URL}?t=${Date.now()}`);
		if (!result?.success || (result.status && result.status !== 200)) return {};
		const registry = clean(JSON.parse(String(result.body)));
		try {
			sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), r: registry }));
		} catch {}
		return registry;
	} catch {
		return {};
	}
}

function swap(img: HTMLImageElement, url: string) {
	if (img.dataset.o2av === url && img.src === url) return;
	img.dataset.o2av = url;
	// the profile page wraps the avatar in <picture> with <source> tags that would win over our src
	img.closest('picture')?.querySelectorAll('source').forEach((s) => s.remove());
	img.removeAttribute('srcset');
	img.style.objectFit = 'cover'; // a picture that isn't square is cropped, not squashed
	img.src = url;
}

function isAvatarImage(img: HTMLImageElement): boolean {
	if (img.closest('.profile_avatar_frame')) return false; // the avatar frame decoration is not the avatar
	if (img.dataset.o2av) return true;
	const own = img.getAttribute('src') || img.getAttribute('srcset') || '';
	return AVATAR_SRC.test(own.trim());
}

function scan(registry: Registry) {
	document.querySelectorAll<HTMLElement>('[data-miniprofile]').forEach((el) => {
		const account = Number(el.dataset.miniprofile);
		if (!account) return;
		const url = registry[(STEAMID64_BASE + BigInt(account)).toString()];
		if (!url) return;
		el.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
			if (isAvatarImage(img)) swap(img, url);
		});
	});
}

export default async function WebkitMain() {
	if (!location.hostname.endsWith('steamcommunity.com')) return;
	const registry = await loadRegistry();
	if (!Object.keys(registry).length) return;

	let timer: any = 0;
	const run = () => {
		try {
			scan(registry);
		} catch {}
	};
	const observer = new MutationObserver(() => {
		clearTimeout(timer);
		timer = setTimeout(run, 200);
	});
	const start = () => {
		if (!document.body) return void setTimeout(start, 200);
		observer.observe(document.body, { childList: true, subtree: true });
		run();
	};
	start();
}
