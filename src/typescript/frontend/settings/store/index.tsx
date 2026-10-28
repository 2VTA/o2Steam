/**
 * o2steam Store: browse and install plugins and themes without leaving the app.
 * Two sources: o2steam's own catalog and the public Millennium plugin list.
 */

import { ConfirmModal, DialogButton, DialogControlsSection, Field, joinClassNames, pluginSelf, showModal, TextField } from '@steambrew/sdk';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FaStore } from 'react-icons/fa';
import { Placeholder } from '../../components/Placeholder';
import { settingsClasses } from '../../utils/classes';
import { backend } from '../../utils/ffi';
import { Installer, InstallType, waitForInstallerComplete } from '../general/Installer';
import { themeSafety } from './theme-safety';
import { Catalog, CatalogPlugin, CatalogTheme, fetchMillenniumPlugins, fetchMillenniumThemes, fetchO2steamCatalog, MillenniumPlugin, MillenniumTheme } from './catalog';

type Source = 'o2steam' | 'millennium';
type Kind = 'plugins' | 'themes';


function confirm(title: string, description: string, okText: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = showModal(
			<ConfirmModal
				strTitle={title}
				strDescription={description}
				strOKButtonText={okText}
				bHideCloseIcon={true}
				onOK={() => {
					resolve(true);
					modal?.Close?.();
				}}
				onCancel={() => {
					resolve(false);
					modal?.Close?.();
				}}
			/>,
			pluginSelf.mainWindow,
			{ bNeverPopOut: true, popupWidth: 500, popupHeight: 275 },
		);
	});
}

function formatCount(n: number) {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function StoreViewModal() {
	const [source, setSource] = useState<Source>('o2steam');
	const [kind, setKind] = useState<Kind>('plugins');
	const [search, setSearch] = useState('');

	const [o2Catalog, setO2Catalog] = useState<Catalog | undefined>(undefined);
	const [o2FromBundle, setO2FromBundle] = useState(false);
	const [millenniumPlugins, setMillenniumPlugins] = useState<MillenniumPlugin[] | undefined>(undefined);
	const [millenniumError, setMillenniumError] = useState<string | undefined>(undefined);
	const [millenniumThemes, setMillenniumThemes] = useState<MillenniumTheme[] | undefined>(undefined);
	const [millenniumThemesError, setMillenniumThemesError] = useState<string | undefined>(undefined);

	// plugin folder names / "owner/repo" of what is installed, and live progress by item key
	const [installed, setInstalled] = useState<Record<string, boolean>>({});
	const [progress, setProgress] = useState<Record<string, string>>({});

	const refreshInstalled = useCallback(async (plugins: string[], themes: { owner: string; repo: string }[]) => {
		const next: Record<string, boolean> = {};
		await Promise.all([
			...plugins.map(async (name) => {
				try {
					next[`plugin:${name}`] = !!(await backend.plugins.isInstalled(name));
				} catch {
					next[`plugin:${name}`] = false;
				}
			}),
			...themes.map(async ({ owner, repo }) => {
				try {
					next[`theme:${owner}/${repo}`] = !!(await backend.themes.isInstalled(owner, repo));
				} catch {
					next[`theme:${owner}/${repo}`] = false;
				}
			}),
		]);
		setInstalled((prev) => ({ ...prev, ...next }));
	}, []);

	useEffect(() => {
		fetchO2steamCatalog().then(({ catalog, fromBundle }) => {
			setO2Catalog(catalog);
			setO2FromBundle(fromBundle);
			refreshInstalled(
				catalog.plugins.map((p) => p.pluginName),
				catalog.themes,
			);
		});

		fetchMillenniumPlugins()
			.then((list) => {
				setMillenniumPlugins(list);
				refreshInstalled(
					list.map((p) => p.pluginName),
					[],
				);
			})
			.catch((e) => setMillenniumError(String(e?.message ?? e)));

		fetchMillenniumThemes()
			.then((list) => {
				setMillenniumThemes(list);
				refreshInstalled(
					[],
					list.map((t) => ({ owner: t.owner, repo: t.repo })),
				);
			})
			.catch((e) => setMillenniumThemesError(String(e?.message ?? e)));
	}, []);

	const matches = (name: string, description: string) => {
		const q = search.trim().toLowerCase();
		return !q || name.toLowerCase().includes(q) || description.toLowerCase().includes(q);
	};

	// ---------------------------------------------------------------- installs

	const trackInstall = async (key: string, start: () => Promise<{ success?: boolean; opId?: number; error?: string; message?: string } | undefined>, after: () => void) => {
		setProgress((p) => ({ ...p, [key]: 'Starting...' }));
		try {
			const result = await start();
			if (!result?.success) {
				setProgress((p) => ({ ...p, [key]: `Failed: ${result?.error ?? result?.message ?? 'could not start'}` }));
				return;
			}

			const ok = await waitForInstallerComplete(result.opId ?? 0, (event) => {
				setProgress((p) => ({ ...p, [key]: `${event.status ?? ''} ${Math.round(event.progress ?? 0)}%`.trim() }));
			});
			setProgress((p) => {
				const copy = { ...p };
				if (ok) delete copy[key];
				else copy[key] = 'Install failed';
				return copy;
			});
			if (ok) after();
		} catch (e: any) {
			setProgress((p) => ({ ...p, [key]: `Failed: ${String(e?.message ?? e)}` }));
		}
	};

	const installO2Plugin = async (plugin: CatalogPlugin) => {
		const sure = await confirm(
			plugin.name,
			'Plugins run code inside Steam, with access to your Steam client. Only install ones you trust. This one comes from the o2steam catalog.',
			'Download and install',
		);
		if (!sure) return;

		await trackInstall(
			`plugin:${plugin.pluginName}`,
			() => backend.plugins.install(plugin.downloadUrl, plugin.size ?? 0),
			() => refreshInstalled([plugin.pluginName], []),
		);
	};

	const installO2Theme = async (theme: CatalogTheme) => {
		const sure = await confirm(theme.name, `Install this theme from github.com/${theme.owner}/${theme.repo}? You can turn it on in the Themes tab.`, 'Download and install');
		if (!sure) return;

		await trackInstall(
			`theme:${theme.owner}/${theme.repo}`,
			() => backend.themes.install(theme.owner, theme.repo),
			() => refreshInstalled([], [theme]),
		);
	};

	const installMillenniumTheme = (theme: MillenniumTheme) => {
		// Millennium's own install window (asks to confirm, shows progress, offers to use the theme)
		new Installer().OpenInstallPrompt(theme.id, InstallType.Theme, () => refreshInstalled([], [{ owner: theme.owner, repo: theme.repo }]));
	};

	const installMillenniumPlugin = (plugin: MillenniumPlugin) => {
		// Millennium's own install window (asks to confirm, shows progress, offers to enable the plugin)
		new Installer().OpenInstallPrompt(plugin.id, InstallType.Plugin, () => refreshInstalled([plugin.pluginName], []));
	};

	// ---------------------------------------------------------------- rendering

	const o2Plugins = useMemo(() => (o2Catalog?.plugins ?? []).filter((p) => matches(p.name, p.description)), [o2Catalog, search]);
	const o2Themes = useMemo(() => (o2Catalog?.themes ?? []).filter((t) => matches(t.name, t.description)), [o2Catalog, search]);
	const mPlugins = useMemo(() => (millenniumPlugins ?? []).filter((p) => matches(p.name, p.description)), [millenniumPlugins, search]);
	// only themes that were safety-reviewed (and carry nothing executable) are shown
	const reviewedThemes = useMemo(() => (millenniumThemes ?? []).filter((t) => {
		const safety = themeSafety(t.owner, t.repo);
		return safety !== undefined && safety.verdict !== 'blocked';
	}), [millenniumThemes]);
	const hiddenThemeCount = (millenniumThemes?.length ?? 0) - reviewedThemes.length;
	const mThemes = useMemo(() => reviewedThemes.filter((t) => matches(t.name, t.description)), [reviewedThemes, search]);

	const InstallButton = ({ itemKey, isInstalled, onClick }: { itemKey: string; isInstalled: boolean; onClick: () => void }) => {
		const busy = progress[itemKey];
		if (busy) return <span style={{ opacity: 0.8, fontSize: 12 }}>{busy}</span>;
		if (isInstalled) return <span style={{ opacity: 0.7 }}>Installed</span>;
		return (
			<DialogButton className={joinClassNames(settingsClasses.SettingsDialogButton, 'MillenniumButton')} onClick={onClick}>
				Install
			</DialogButton>
		);
	};

	const tabButton = (label: string, active: boolean, onClick: () => void) => (
		<DialogButton
			className={joinClassNames(settingsClasses.SettingsDialogButton, 'MillenniumButton')}
			style={active ? { background: 'rgba(102, 192, 244, 0.35)' } : undefined}
			onClick={onClick}
		>
			{label}
		</DialogButton>
	);

	const emptyNote = (text: string) => <Placeholder icon={<FaStore className="SVGIcon_Button" />} header="Nothing here yet" body={text} />;

	let body: React.ReactNode;
	if (source === 'o2steam') {
		if (!o2Catalog) {
			body = emptyNote('Loading the o2steam catalog...');
		} else if (kind === 'plugins') {
			body = o2Plugins.length
				? o2Plugins.map((p) => (
						<Field key={p.pluginName} label={`${p.name}${p.version ? `  v${p.version}` : ''}`} description={`${p.description}${p.author ? `  - by ${p.author}` : ''}`} bottomSeparator="standard">
							<InstallButton itemKey={`plugin:${p.pluginName}`} isInstalled={!!installed[`plugin:${p.pluginName}`]} onClick={() => installO2Plugin(p)} />
						</Field>
					))
				: emptyNote(o2FromBundle ? 'The o2steam catalog has no plugins yet (or it could not be loaded). Try the Millennium list.' : 'The o2steam catalog has no plugins yet. Try the Millennium list.');
		} else {
			body = o2Themes.length
				? o2Themes.map((t) => (
						<Field key={`${t.owner}/${t.repo}`} label={t.name} description={`${t.description}${t.author ? `  - by ${t.author}` : ''}`} bottomSeparator="standard">
							<InstallButton itemKey={`theme:${t.owner}/${t.repo}`} isInstalled={!!installed[`theme:${t.owner}/${t.repo}`]} onClick={() => installO2Theme(t)} />
						</Field>
					))
				: emptyNote(o2FromBundle ? 'The o2steam catalog has no themes yet (or it could not be loaded).' : 'The o2steam catalog has no themes yet.');
		}
	} else if (kind === 'plugins') {
		if (millenniumError) {
			body = emptyNote(`Could not load the Millennium list (${millenniumError}). Check your connection and try again.`);
		} else if (!millenniumPlugins) {
			body = emptyNote('Loading the Millennium plugin list...');
		} else {
			body = mPlugins.length
				? mPlugins.map((p) => (
						<Field
							key={p.id}
							label={`${p.name}${p.version ? `  v${p.version}` : ''}`}
							description={`${p.description}${p.author ? `  - by ${p.author}` : ''}  (${formatCount(p.downloads)} downloads, ${p.stars} stars)`}
							bottomSeparator="standard"
						>
							{p.hasValidBuild ? (
								<InstallButton itemKey={`plugin:${p.pluginName}`} isInstalled={!!installed[`plugin:${p.pluginName}`]} onClick={() => installMillenniumPlugin(p)} />
							) : (
								<span style={{ opacity: 0.6 }}>Build is broken</span>
							)}
						</Field>
					))
				: emptyNote('No plugin matches your search.');
		}
	} else if (millenniumThemesError) {
		body = emptyNote(`Could not load the Millennium theme list (${millenniumThemesError}). Try again in a moment.`);
	} else if (!millenniumThemes) {
		body = emptyNote('Loading the Millennium theme list...');
	} else {
		const safetyLine = (owner: string, repo: string) => {
			const safety = themeSafety(owner, repo);
			if (!safety) return '';
			const base = safety.verdict === 'clean' ? 'Checked: no outside connections' : `Reaches outside Steam: ${safety.hosts.join(', ')}`;
			return `\n${base}${safety.note ? `. ${safety.note}` : ''}`;
		};

		body = mThemes.length ? (
			<>
				<Field
					label="Safety-checked themes"
					description={`Every theme here was scanned for executables, scripts that call out, and outside links.${hiddenThemeCount > 0 ? ` ${hiddenThemeCount} theme${hiddenThemeCount === 1 ? ' is' : 's are'} hidden (not reviewed yet, or they ship an executable file).` : ''} Turn on "Block external connections in themes" in General to stop style files from loading anything outside Steam.`}
					bottomSeparator="standard"
				/>
				{mThemes.map((t) => (
					<Field
						key={t.id}
						icon={t.image ? <img src={t.image} style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 4 }} /> : undefined}
						label={`${t.name}${t.version ? `  v${t.version}` : ''}`}
						description={`${t.description}${t.tags.length ? `  [${t.tags.join(', ')}]` : ''}  (${formatCount(t.downloads)} downloads)${safetyLine(t.owner, t.repo)}`}
						bottomSeparator="standard"
					>
						<InstallButton itemKey={`theme:${t.owner}/${t.repo}`} isInstalled={!!installed[`theme:${t.owner}/${t.repo}`]} onClick={() => installMillenniumTheme(t)} />
					</Field>
				))}
			</>
		) : (
			emptyNote('No theme matches your search.')
		);
	}

	return (
		<>
			<DialogControlsSection className="MillenniumButtonsSection">
				{tabButton('o2steam', source === 'o2steam', () => setSource('o2steam'))}
				{tabButton('Millennium', source === 'millennium', () => setSource('millennium'))}
				{tabButton('Plugins', kind === 'plugins', () => setKind('plugins'))}
				{tabButton('Themes', kind === 'themes', () => setKind('themes'))}
			</DialogControlsSection>
			<div style={{ padding: '8px 0' }}>
				<TextField
					// @ts-ignore
					placeholder="Search"
					value={search}
					onChange={(e: any) => setSearch(e.target.value)}
				/>
			</div>
			{body}
		</>
	);
}
