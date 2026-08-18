// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Bottom-nav shell mirroring the web app's mobile navigation
// (Library · Explore · Collections · Updates · Search). This replaces the
// folder-tree drawer as the PRIMARY navigation surface — folder browsing
// is now a secondary drawer inside the Library tab, not the app's nav.
//
// Phase 6.6a: Library + Search are wired to live data. Explore,
// Collections, and Updates are placeholders pending 6.6b (mobile client
// methods for collections / workspace activity / people-places-things).

import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../api/fonto_client.dart";
import "../state/auth_store.dart";
import "collections_screen.dart";
import "explore_screen.dart";
import "home_screen.dart";
import "search_screen.dart";
import "updates_screen.dart";

class MainShell extends StatefulWidget {
  const MainShell({super.key, required this.auth, required this.onSignOut});

  final AuthStore auth;
  final VoidCallback onSignOut;

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  late final FontoClient _client = FontoClient(widget.auth);
  int _index = 0;

  // Lazily-built tabs: each screen (and its initState network fetch) is only
  // constructed on first visit, then kept alive. A cold start no longer fans
  // out five parallel fetches — only the visible Library tab loads.
  final List<Widget?> _tabs = List<Widget?>.filled(5, null);

  @override
  void dispose() {
    _client.close();
    super.dispose();
  }

  Widget _buildTab(int i) {
    switch (i) {
      case 0:
        return HomeScreen(auth: widget.auth, onSignOut: widget.onSignOut);
      case 1:
        return ExploreScreen(client: _client);
      case 2:
        return CollectionsScreen(client: _client);
      case 3:
        return UpdatesScreen(client: _client);
      case 4:
        return SearchScreen(client: _client);
      default:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    // Build the active tab on demand; already-built tabs stay in the list so
    // their scroll position + fetched data survive tab switches.
    _tabs[_index] ??= _buildTab(_index);
    final tabs = <Widget>[
      for (final tab in _tabs) tab ?? const SizedBox.shrink(),
    ];

    final theme = Theme.of(context);
    // Phase 7 AA pass: inactive label uses onSurface @ 70% (passes WCAG AA
    // against light + dark surfaces); active is full-weight onSurface +
    // teal icon + the indicator highlight (NavigationBar's built-in pill).
    // Mirrors the web AppMobileBottomBar tokens.
    final inactiveText = theme.colorScheme.onSurface.withValues(alpha: 0.7);
    final inactiveIcon = theme.colorScheme.onSurfaceVariant;
    final activeText = theme.colorScheme.onSurface;
    final activeIcon = theme.colorScheme.primary;

    return Scaffold(
      body: IndexedStack(index: _index, children: tabs),
      bottomNavigationBar: NavigationBarTheme(
        // Merge onto the global navigationBarTheme so its backgroundColor,
        // elevation:0, and height:80 survive — NavigationBarTheme.of() does
        // NOT merge ThemeData.navigationBarTheme, so a bare data here would
        // silently re-add the M3 default elevation (drop shadow).
        data: theme.navigationBarTheme.copyWith(
          indicatorColor: theme.colorScheme.primary.withValues(alpha: 0.12),
          labelTextStyle: WidgetStateProperty.resolveWith((states) {
            final selected = states.contains(WidgetState.selected);
            // Off theme.textTheme.labelSmall so the Inter family + tracking
            // carry through instead of a bare TextStyle.
            return theme.textTheme.labelSmall?.copyWith(
              fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
              color: selected ? activeText : inactiveText,
            );
          }),
          iconTheme: WidgetStateProperty.resolveWith((states) {
            final selected = states.contains(WidgetState.selected);
            return IconThemeData(
              size: 22,
              color: selected ? activeIcon : inactiveIcon,
            );
          }),
        ),
        child: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (i) {
            HapticFeedback.selectionClick();
            setState(() => _index = i);
          },
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.photo_library_outlined),
              selectedIcon: Icon(Icons.photo_library),
              label: "Library",
            ),
            NavigationDestination(
              icon: Icon(Icons.explore_outlined),
              selectedIcon: Icon(Icons.explore),
              label: "Explore",
            ),
            NavigationDestination(
              icon: Icon(Icons.collections_bookmark_outlined),
              selectedIcon: Icon(Icons.collections_bookmark),
              label: "Collections",
            ),
            NavigationDestination(
              icon: Icon(Icons.notifications_outlined),
              selectedIcon: Icon(Icons.notifications),
              label: "Updates",
            ),
            NavigationDestination(
              icon: Icon(Icons.search),
              selectedIcon: Icon(Icons.search),
              label: "Search",
            ),
          ],
        ),
      ),
    );
  }
}
