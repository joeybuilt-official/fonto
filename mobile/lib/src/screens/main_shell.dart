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

  @override
  void dispose() {
    _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tabs = <Widget>[
      HomeScreen(auth: widget.auth, onSignOut: widget.onSignOut),
      ExploreScreen(client: _client),
      CollectionsScreen(client: _client),
      UpdatesScreen(client: _client),
      SearchScreen(client: _client),
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
        data: NavigationBarThemeData(
          indicatorColor: theme.colorScheme.primary.withValues(alpha: 0.12),
          labelTextStyle: WidgetStateProperty.resolveWith((states) {
            final selected = states.contains(WidgetState.selected);
            return TextStyle(
              fontSize: 11,
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
          onDestinationSelected: (i) => setState(() => _index = i),
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
              label: "Search",
            ),
          ],
        ),
      ),
    );
  }
}
