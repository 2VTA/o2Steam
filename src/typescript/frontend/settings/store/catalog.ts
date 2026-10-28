/**
 * o2steam Store: where the lists come from.
 *
 *  - "o2steam"    our own catalog: a JSON file in the o2Steam repo (catalog.json). Plugins are installed from
 *                 a zip link, themes from a GitHub repo. If the file can't be read (offline, or the repo is
 *                 still private) the copy bundled below is used.
 *  - "Millennium" the public Millennium plugin list (the same one its website shows), installed with
 *                 Millennium's own installer by plugin id.
 */

import { API_URL } from '../../utils/globals';
import { backend } from '../../utils/ffi';

export const O2STEAM_CATALOG_URL = 'https://raw.githubusercontent.com/2VTA/o2Steam/main/catalog.json';

export interface CatalogPlugin {
	/** folder name the plugin installs as (the "name" in its plugin.json); used to tell if it is installed */
	pluginName: string;
	name: string;
	description: string;
	author?: string;
	version?: string;
	/** zip with the plugin folder inside */
	downloadUrl: string;
	size?: number;
}

export interface CatalogTheme {
	name: string;
	description: string;
	author?: string;
	/** GitHub repo the theme is installed from */
	owner: string;
	repo: string;
}

export interface Catalog {
	plugins: CatalogPlugin[];
	themes: CatalogTheme[];
}

// Starts empty on purpose: nothing goes in the store until it has been looked at. Add entries to
// catalog.json in the repo (or here) when there are some.
export const BUNDLED_CATALOG: Catalog = { plugins: [], themes: [] };

function isText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isHttps(value: unknown): value is string {
	return typeof value === 'string' && /^https:\/\//i.test(value);
}

/** Keeps only well-formed entries, so a bad catalog file can't break the page or install from odd places. */
export function cleanCatalog(raw: any): Catalog {
	const plugins: CatalogPlugin[] = [];
	for (const item of Array.isArray(raw?.plugins) ? raw.plugins : []) {
		if (!isText(item?.pluginName) || !isText(item?.name) || !isHttps(item?.downloadUrl)) continue;
		plugins.push({
			pluginName: item.pluginName.trim(),
			name: item.name.trim().slice(0, 80),
			description: isText(item.description) ? item.description.trim().slice(0, 400) : '',
			author: isText(item.author) ? item.author.trim().slice(0, 60) : undefined,
			version: isText(item.version) ? item.version.trim().slice(0, 20) : undefined,
			downloadUrl: item.downloadUrl,
			size: typeof item.size === 'number' && item.size > 0 ? item.size : undefined,
		});
	}

	const themes: CatalogTheme[] = [];
	for (const item of Array.isArray(raw?.themes) ? raw.themes : []) {
		if (!isText(item?.owner) || !isText(item?.repo) || !isText(item?.name)) continue;
		if (!/^[A-Za-z0-9_.-]+$/.test(item.owner) || !/^[A-Za-z0-9_.-]+$/.test(item.repo)) continue;
		themes.push({
			name: item.name.trim().slice(0, 80),
			description: isText(item.description) ? item.description.trim().slice(0, 400) : '',
			author: isText(item.author) ? item.author.trim().slice(0, 60) : undefined,
			owner: item.owner.trim(),
			repo: item.repo.trim(),
		});
	}

	return { plugins, themes };
}

export async function fetchO2steamCatalog(): Promise<{ catalog: Catalog; fromBundle: boolean }> {
	try {
		const result = await backend.store.fetchJson(`${O2STEAM_CATALOG_URL}?t=${Date.now()}`);
		if (!result?.success || !result.body) throw new Error(result?.error ?? 'no data');
		return { catalog: cleanCatalog(JSON.parse(result.body)), fromBundle: false };
	} catch {
		return { catalog: BUNDLED_CATALOG, fromBundle: true };
	}
}

export interface MillenniumPlugin {
	/** the 12 character id Millennium's installer takes */
	id: string;
	pluginName: string;
	name: string;
	description: string;
	author: string;
	version?: string;
	downloads: number;
	stars: number;
	hasValidBuild: boolean;
}

export async function fetchMillenniumPlugins(): Promise<MillenniumPlugin[]> {
	const result = await backend.store.fetchJson(`${API_URL}/api/v1/plugins`);
	if (!result?.success || !result.body) throw new Error(result?.error ?? 'no data');

	const list = JSON.parse(result.body);
	const plugins: MillenniumPlugin[] = [];
	for (const item of Array.isArray(list) ? list : []) {
		const json = item?.pluginJson;
		if (!isText(item?.id) || !isText(json?.name) || !isText(json?.common_name)) continue;
		plugins.push({
			id: item.id,
			pluginName: json.name,
			name: json.common_name,
			description: isText(json.description) ? json.description.trim().slice(0, 400) : '',
			author: isText(item.repoOwner) ? item.repoOwner : '',
			version: isText(json.version) ? json.version : undefined,
			downloads: Number(item.downloadCount) || 0,
			stars: Number(item.stargazerCount) || 0,
			hasValidBuild: item.hasValidBuild !== false,
		});
	}

	return plugins.sort((a, b) => b.downloads - a.downloads);
}
