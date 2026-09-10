/**
 * Chrome menu protocol: lets other extensions add menus to the HUD's input-box
 * border over `pi.events`, the same way `pi-auto-compact` publishes its policy.
 *
 * The HUD emits CHROME_MENU_REQUEST_EVENT when it installs so extensions that
 * loaded earlier can re-announce; extensions emit CHROME_MENU_EVENT whenever
 * their menu changes. Re-emitting with the same id replaces the earlier menu.
 */
export const CHROME_MENU_REQUEST_EVENT = "pi-session-hud:chrome-menu-request:v1";
export const CHROME_MENU_EVENT = "pi-session-hud:chrome-menu:v1";

export type ChromeMenuItem = {
	/** Passed to onSelect; unique within the menu. */
	value: string;
	label: string;
	description?: string;
};

export type ChromeMenuExtend = "model" | "thinking";

export type ChromeMenu = {
	protocolVersion: 1;
	/** Stable key, typically the extension name. */
	id: string;
	/** Segment text in the input border, after the thinking level. Omit when only extending a built-in popup. */
	label?: string;
	/** Popup title; defaults to the label or id. */
	title?: string;
	/** Popup rows. A function is called each time the popup opens. */
	items?: ChromeMenuItem[] | (() => ChromeMenuItem[]);
	/** Value of the row marked as current. */
	current?: string | (() => string | undefined);
	/** Append the rows to a built-in popup instead of (or as well as) the menu's own popup. */
	extend?: ChromeMenuExtend;
	onSelect?: (value: string) => void | Promise<void>;
};

export type ChromeMenuRemoval = {
	protocolVersion: 1;
	id: string;
	remove: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseItem(value: unknown): ChromeMenuItem | undefined {
	if (!isRecord(value) || typeof value.value !== "string" || typeof value.label !== "string") return undefined;
	if (value.description !== undefined && typeof value.description !== "string") return undefined;
	return { value: value.value, label: value.label, ...(value.description !== undefined ? { description: value.description } : {}) };
}

export function parseChromeMenuItems(value: unknown): ChromeMenuItem[] {
	if (!Array.isArray(value)) return [];
	const items: ChromeMenuItem[] = [];
	for (const entry of value) {
		const item = parseItem(entry);
		if (item) items.push(item);
	}
	return items;
}

/** Validate an event payload; malformed payloads are ignored rather than trusted. */
export function parseChromeMenu(value: unknown): ChromeMenu | ChromeMenuRemoval | undefined {
	if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.id !== "string" || value.id === "") return undefined;
	if (value.remove === true) return { protocolVersion: 1, id: value.id, remove: true };
	const { label, title, items, current, extend, onSelect } = value;
	if (label !== undefined && typeof label !== "string") return undefined;
	if (title !== undefined && typeof title !== "string") return undefined;
	if (items !== undefined && typeof items !== "function" && !Array.isArray(items)) return undefined;
	if (current !== undefined && typeof current !== "string" && typeof current !== "function") return undefined;
	if (extend !== undefined && extend !== "model" && extend !== "thinking") return undefined;
	if (onSelect !== undefined && typeof onSelect !== "function") return undefined;
	return {
		protocolVersion: 1,
		id: value.id,
		...(label !== undefined ? { label } : {}),
		...(title !== undefined ? { title } : {}),
		...(items !== undefined ? { items: Array.isArray(items) ? parseChromeMenuItems(items) : (items as () => ChromeMenuItem[]) } : {}),
		...(current !== undefined ? { current: current as string | (() => string | undefined) } : {}),
		...(extend !== undefined ? { extend } : {}),
		...(onSelect !== undefined ? { onSelect: onSelect as ChromeMenu["onSelect"] } : {}),
	};
}

/** Resolve a menu's rows and current value at popup-open time. */
export function resolveChromeMenu(menu: ChromeMenu): { items: ChromeMenuItem[]; current: string | undefined } {
	const items = typeof menu.items === "function" ? parseChromeMenuItems(menu.items()) : (menu.items ?? []);
	const current = typeof menu.current === "function" ? menu.current() : menu.current;
	return { items, current: typeof current === "string" ? current : undefined };
}
