"use client";
import { useEffect } from "react";
import { create } from "zustand";
import { SIDEBAR_STORAGE_KEY, parseCollapsed, serializeCollapsed } from "./sidebarState";

interface SidebarState {
  collapsed: boolean;
  loaded: boolean;
  load: () => void;
  toggle: () => void;
}

/** Default is expanded so server and first client render match; the stored value is applied in an effect. */
const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: false,
  loaded: false,
  load: () => {
    if (get().loaded) return;
    let stored = false;
    try {
      stored = parseCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
    } catch {
      /* storage unavailable: stay expanded */
    }
    set({ collapsed: stored, loaded: true });
  },
  toggle: () => {
    const next = !get().collapsed;
    set({ collapsed: next, loaded: true });
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, serializeCollapsed(next));
    } catch {
      /* ignore */
    }
  },
}));

export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggle = useSidebarStore((s) => s.toggle);
  const load = useSidebarStore((s) => s.load);
  useEffect(() => {
    load();
  }, [load]);
  return { collapsed, toggle };
}
