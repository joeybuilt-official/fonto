// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M12 / ADR 0014 — "LIVE" pill for motion (Live) photos. Web parity: the grid
// tile shows it; the detail view shows it as a hint to long-press for playback.

import "package:flutter/material.dart";

class LiveBadge extends StatelessWidget {
  const LiveBadge({super.key, this.compact = false});

  /// Grid tiles use the compact size; the full-screen viewer uses the larger.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 5 : 8,
        vertical: compact ? 2 : 3,
      ),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.scrim.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.radio_button_checked,
            size: compact ? 11 : 12,
            color: Colors.white,
          ),
          SizedBox(width: compact ? 2 : 3),
          Text(
            "LIVE",
            style: TextStyle(
              color: Colors.white,
              fontSize: compact ? 8 : 10,
              fontWeight: FontWeight.w700,
              letterSpacing: compact ? 0.3 : 0.5,
            ),
          ),
        ],
      ),
    );
  }
}
