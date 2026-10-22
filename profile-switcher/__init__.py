"""Profile Switcher — agent-side half.

This plugin is DESKTOP-ONLY: its whole surface is the Hermes Desktop
renderer (`desktop/plugin.js`), which the app loads from the plugin
folder. There is no agent-side behaviour — no tools, no hooks, no
middleware, no CLI command — so this module registers nothing on purpose.

It exists because the directory-plugin loader requires an ``__init__.py``
beside ``plugin.yaml`` for ANY plugin that is not a locales-only pack; a
manifest without one is refused at load time ("No __init__.py"), and
``hermes plugins validate`` then reports "nothing to load".

The desktop half is the real plugin. See ``desktop/plugin.js``.
"""

from __future__ import annotations

from typing import Any, Dict


def register(ctx: Any) -> None:
    """Register nothing.

    The desktop half registers its own surfaces (the switcher panel, the
    status-bar chip, the palette command, and the keybind) through the
    Desktop plugin SDK when the app loads it. There is deliberately no
    agent-side registration: a declared capability that does not exist
    would fail the catalog's capability check.
    """
    return None


__all__ = ["register"]
