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
import "home_screen.dart";
import "search_screen.dart";

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
      const _ComingSoon(
        icon: Icons.explore_outlined,
        title: "Explore",
        sections: ["People", "Places", "Things"],
      ),
      CollectionsScreen(client: _client),
      const _ComingSoon(
        icon: Icons.notifications_outlined,
        title: "Updates",
        sections: ["Uploads", "Activity", "Shared with me"],
      ),
      SearchScreen(client: _client),
    ];

    return Scaffold(
      body: IndexedStack(index: _index, children: tabs),
      bottomNavigationBar: NavigationBar(
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
    );
  }
}

class _ComingSoon extends StatelessWidget {
  const _ComingSoon({
    required this.icon,
    required this.title,
    required this.sections,
  });

  final IconData icon;
  final String title;
  final List<String> sections;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 48, color: theme.colorScheme.primary),
              const SizedBox(height: 16),
              Text(
                "$title — coming soon",
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                sections.join("  ·  "),
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.outline),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
