// profile-switcher/src/plugin.tsx
import {
  Badge,
  Codicon,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  atom,
  useQuery,
  useValue
} from "@hermes/plugin-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// profile-switcher/src/roster.ts
function normalizeProfileKey(name) {
  return (name ?? "").trim().toLowerCase();
}
function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1e3) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return toEpochMs(numeric);
    }
  }
  return 0;
}
function oneLine(text, max = 140) {
  if (typeof text !== "string") {
    return "";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
function buildRoster(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row.name !== "string" || !row.name.trim()) {
      continue;
    }
    const last = row.last_session ?? null;
    const worker = row.worker_session ?? null;
    entries.push({
      name: row.name.trim(),
      label: typeof row.display_name === "string" && row.display_name.trim() || row.name.trim(),
      isDefault: row.is_default === true,
      lastSessionId: typeof last?.id === "string" ? last.id.trim() : "",
      lastTitle: oneLine(last?.title, 80),
      lastPreview: oneLine(last?.preview, 140),
      lastActiveAt: toEpochMs(last?.last_active ?? last?.started_at),
      working: Boolean(worker),
      model: typeof row.model === "string" ? row.model : "",
      skillCount: typeof row.skill_count === "number" ? row.skill_count : 0
    });
  }
  const isDefault = entries.find((entry) => entry.isDefault);
  const named = entries.filter((entry) => !entry.isDefault);
  return isDefault ? [isDefault, ...named] : named;
}
function nextIndex(current, direction, length) {
  if (length <= 0) {
    return 0;
  }
  const start = current < 0 ? direction === 1 ? -1 : 0 : current;
  return ((start + direction) % length + length) % length;
}
function indexOfProfile(entries, profileName) {
  const key = normalizeProfileKey(profileName);
  return entries.findIndex((entry) => normalizeProfileKey(entry.name) === key);
}
function filterRoster(entries, query) {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) {
    return [...entries];
  }
  return entries.filter(
    (entry) => [entry.name, entry.label, entry.lastTitle, entry.lastPreview].some(
      (text) => (text ?? "").toLowerCase().includes(needle)
    )
  );
}

// profile-switcher/src/plugin.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var ID = "profile-switcher";
var $switcherOpen = atom(false);
var $query = atom("");
var DEFAULT_SETTINGS = {
  showModel: true,
  showLastSession: true
};
var $settings = atom(DEFAULT_SETTINGS);
var storage = null;
var STORAGE_KEY = "settings";
function readSettings() {
  if (!storage) {
    return DEFAULT_SETTINGS;
  }
  try {
    const stored = storage.get(STORAGE_KEY, {});
    return {
      showModel: typeof stored?.showModel === "boolean" ? stored.showModel : DEFAULT_SETTINGS.showModel,
      showLastSession: typeof stored?.showLastSession === "boolean" ? stored.showLastSession : DEFAULT_SETTINGS.showLastSession
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
function writeSettings(settings) {
  try {
    storage?.set(STORAGE_KEY, settings);
  } catch {
  }
}
var ROSTER_KEY = [ID, "roster"];
async function fetchRoster() {
  const result = await host.request("profiles.list", { include_sessions: true });
  return Array.isArray(result?.profiles) ? result.profiles : [];
}
function openSwitcher() {
  $query.set("");
  $switcherOpen.set(true);
}
function closeSwitcher() {
  $switcherOpen.set(false);
  $query.set("");
}
function relativeLabel(epochMs) {
  if (!epochMs) {
    return "";
  }
  const delta = Date.now() - epochMs;
  if (delta < 0) {
    return "now";
  }
  const minutes = Math.floor(delta / 6e4);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d`;
  }
  return new Date(epochMs).toLocaleDateString();
}
function pickProfile(entry) {
  closeSwitcher();
  const lastId = entry.lastSessionId;
  if (lastId && typeof host.openSession === "function") {
    void host.openSession(lastId, {
      expectHistory: false,
      keepAllProfilesScope: false,
      profile: entry.name
    }).catch((error) => {
      host.notifyError(error, `Could not switch to profile "${entry.name}"`);
    });
    return;
  }
  if (typeof host.newChat === "function") {
    host.newChat(entry.name);
    return;
  }
  host.notify({
    kind: "error",
    message: "This Hermes Desktop build cannot switch profiles. Update Hermes Desktop."
  });
}
function ProfileRowView({
  active,
  entry,
  index,
  selected,
  showLastSession,
  showModel,
  onPick
}) {
  const last = relativeLabel(entry.lastActiveAt);
  const muted = selected ? "text-(--ui-accent-foreground)/70" : "text-(--ui-text-quaternary)";
  return /* @__PURE__ */ jsxs(
    "button",
    {
      className: [
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-(--ui-accent) text-(--ui-accent-foreground)" : "text-(--ui-text-secondary) hover:bg-(--ui-hover-surface)"
      ].join(" "),
      "data-selected": selected ? "true" : "false",
      onClick: onPick,
      type: "button",
      children: [
        /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5", children: [
            /* @__PURE__ */ jsx("span", { className: "truncate text-[0.8125rem] font-medium", children: entry.label }),
            active ? /* @__PURE__ */ jsx(Badge, { variant: "muted", children: "active" }) : null,
            entry.working ? /* @__PURE__ */ jsx(Codicon, { name: "loading~spin", size: "0.75rem" }) : null
          ] }),
          showLastSession && entry.lastTitle ? /* @__PURE__ */ jsx("div", { className: `truncate text-[0.6875rem] ${muted}`, children: entry.lastTitle }) : null
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex shrink-0 items-center gap-1.5", children: [
          showModel && entry.model ? /* @__PURE__ */ jsx("span", { className: `max-w-[9rem] truncate font-mono text-[0.625rem] ${muted}`, title: entry.model, children: entry.model }) : null,
          last ? /* @__PURE__ */ jsx("span", { className: `text-[0.625rem] tabular-nums ${muted}`, children: last }) : null,
          /* @__PURE__ */ jsx(
            "span",
            {
              className: [
                "w-4 text-right font-mono text-[0.625rem] tabular-nums",
                selected ? "text-(--ui-accent-foreground)/70" : "text-(--ui-text-tertiary)"
              ].join(" "),
              children: index < 9 ? String(index + 1) : ""
            }
          )
        ] })
      ]
    }
  );
}
function SwitcherPanel() {
  const open = useValue($switcherOpen);
  const query = useValue($query);
  const settings = useValue($settings);
  const activeProfile = useValue(host.state.profile);
  const { data } = useQuery({
    queryFn: fetchRoster,
    queryKey: ROSTER_KEY,
    staleTime: 15e3
  });
  const roster = useMemo(() => buildRoster(data ?? []), [data]);
  const entries = useMemo(() => filterRoster(roster, query), [roster, query]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const index = indexOfProfile(entries, activeProfile);
    setSelected(index >= 0 ? index : 0);
  }, [activeProfile, entries, open]);
  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);
  const move = useCallback(
    (direction) => {
      setSelected((current) => nextIndex(current, direction, entries.length));
    },
    [entries.length]
  );
  const commit = useCallback(() => {
    const entry = entries[selected];
    if (entry) {
      pickProfile(entry);
    }
  }, [entries, selected]);
  useEffect(() => {
    if (!open) {
      return void 0;
    }
    const onKeyDown = (event) => {
      if (event.key === "ArrowDown" || event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [commit, move, open]);
  if (!open) {
    return null;
  }
  return /* @__PURE__ */ jsxs("div", { className: "fixed inset-0 z-50 flex items-start justify-center pt-[12vh]", children: [
    /* @__PURE__ */ jsx("div", { className: "absolute inset-0", onMouseDown: closeSwitcher }),
    /* @__PURE__ */ jsxs(
      "div",
      {
        className: [
          "relative w-[min(30rem,calc(100vw-2rem))] overflow-hidden rounded-xl border",
          "border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous"
        ].join(" "),
        onMouseDown: (event) => event.stopPropagation(),
        children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2", children: [
            /* @__PURE__ */ jsx("span", { className: "text-[0.8125rem] font-medium text-(--ui-text-primary)", children: "Switch profile" }),
            /* @__PURE__ */ jsx("span", { className: "text-[0.6875rem] text-(--ui-text-quaternary)", children: "\u2191\u2193 move \xB7 Enter switch \xB7 Esc cancel" })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "max-h-[min(24rem,60vh)] overflow-y-auto p-1", ref: listRef, children: entries.length === 0 ? /* @__PURE__ */ jsx("div", { className: "px-3 py-6 text-center text-[0.8125rem] text-(--ui-text-quaternary)", children: query ? `No profile matches "${query}"` : "No profiles found" }) : entries.map((entry, index) => /* @__PURE__ */ jsx(
            ProfileRowView,
            {
              active: entry.name.toLowerCase() === activeProfile.toLowerCase(),
              entry,
              index,
              onPick: () => pickProfile(entry),
              selected: index === selected,
              showLastSession: settings.showLastSession,
              showModel: settings.showModel
            },
            entry.name
          )) })
        ]
      }
    )
  ] });
}
function ProfileChip() {
  const profile = useValue(host.state.profile);
  return /* @__PURE__ */ jsxs(
    "button",
    {
      className: "inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground",
      onClick: openSwitcher,
      title: `Active profile: ${profile} \u2014 click to switch`,
      type: "button",
      children: [
        /* @__PURE__ */ jsx(Codicon, { name: "account", size: "0.75rem" }),
        /* @__PURE__ */ jsx("span", { className: "font-mono", children: profile })
      ]
    }
  );
}
function SettingsPage() {
  const settings = useValue($settings);
  const update = (patch) => {
    const next = { ...settings, ...patch };
    $settings.set(next);
    writeSettings(next);
  };
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3 p-3 text-sm", children: [
    /* @__PURE__ */ jsxs("label", { className: "flex items-center justify-between gap-4", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        "Show model",
        /* @__PURE__ */ jsx("span", { className: "block text-[0.6875rem] text-(--ui-text-quaternary)", children: "Show each profile\u2019s model slug in the switcher row" })
      ] }),
      /* @__PURE__ */ jsx(
        "input",
        {
          checked: settings.showModel,
          onChange: (event) => update({ showModel: event.target.checked }),
          type: "checkbox"
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("label", { className: "flex items-center justify-between gap-4", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        "Show last conversation",
        /* @__PURE__ */ jsx("span", { className: "block text-[0.6875rem] text-(--ui-text-quaternary)", children: "Show the title of each profile\u2019s most recent conversation" })
      ] }),
      /* @__PURE__ */ jsx(
        "input",
        {
          checked: settings.showLastSession,
          onChange: (event) => update({ showLastSession: event.target.checked }),
          type: "checkbox"
        }
      )
    ] })
  ] });
}
var plugin_default = {
  id: ID,
  name: "Profile Switcher",
  description: "A macOS-style quick switcher for Hermes profiles: one chord opens a panel of every profile, with its model and last conversation, and lands you on the one you pick.",
  defaultEnabled: false,
  register(ctx) {
    storage = ctx.storage ?? null;
    $settings.set(readSettings());
    ctx.registerMany([
      // The switcher panel. A floating pane renders above the app's own
      // surfaces; it is mounted always but renders nothing until opened, so
      // it is not a permanent card in the corner.
      {
        id: "switcher",
        area: "panes",
        data: {
          placement: "floating",
          anchor: "top-right",
          width: "26rem",
          height: "auto"
        },
        title: "Switch profile",
        render: () => /* @__PURE__ */ jsx(SwitcherPanel, {})
      },
      {
        id: "chip",
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => /* @__PURE__ */ jsx(ProfileChip, {})
      },
      {
        id: "open",
        area: PALETTE_AREA,
        data: {
          id: "profile-switcher.open",
          label: "Switch profile\u2026",
          keywords: ["profile", "switch", "workspace", "context", "agent"],
          run: openSwitcher
        }
      },
      // The keybind: ⌥⌘P opens the switcher. It is CONTRIBUTED, so it appears
      // in the app's own keybind panel and the user can rebind or clear it
      // like any other shortcut. `mod+alt+p` is free: core uses `mod+alt`
      // only for the profile slots 10-18 (`mod+alt+1…9`) and `mod+alt+t`.
      {
        id: "keybind",
        area: KEYBINDS_AREA,
        data: {
          id: "profile-switcher.open",
          category: "profiles",
          defaults: ["mod+alt+p"],
          label: "Switch profile\u2026",
          run: openSwitcher
        }
      }
    ]);
    if (typeof ctx.registerSettingsPage === "function") {
      ctx.registerSettingsPage({
        id: "settings",
        title: "Profile Switcher",
        icon: "account",
        render: () => /* @__PURE__ */ jsx(SettingsPage, {})
      });
    }
    ctx.onDispose(() => {
      closeSwitcher();
      storage = null;
    });
  }
};
export {
  plugin_default as default
};
