// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Ignored review screen — the mobile mirror of the web
// app/(app)/app/people/ignored page. Lists the three things a user can
// ignore (hidden person clusters, individually-hidden faces, and photos whose
// faces are all ignored) and lets them restore each. Pops `true` when anything
// was restored so the People grid reloads.

import "package:cached_network_image/cached_network_image.dart";
import "package:flutter/material.dart";

import "../api/fonto_client.dart";
import "../api/models.dart";
import "../widgets/list_states.dart";

class IgnoredPeopleScreen extends StatefulWidget {
  const IgnoredPeopleScreen({super.key, required this.client});

  final FontoClient client;

  @override
  State<IgnoredPeopleScreen> createState() => _IgnoredPeopleScreenState();
}

class _IgnoredPeopleScreenState extends State<IgnoredPeopleScreen> {
  bool _loading = true;
  String? _error;
  bool _changed = false;

  List<Person> _persons = const [];
  List<IgnoredFace> _faces = const [];
  List<IgnoredPhoto> _photos = const [];

  final Map<String, String> _personCrops = {}; // personId -> url
  final Map<String, String> _faceCrops = {}; // faceId -> url
  final Map<String, String> _photoThumbs = {}; // assetId -> url

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _personCrops.clear();
      _faceCrops.clear();
      _photoThumbs.clear();
    });
    try {
      final data = await widget.client.listIgnored();

      final personCrops = <String, String>{};
      await Future.wait(
        data.persons.where((p) => p.coverFaceCropUrl != null).map((p) async {
          final u = await widget.client.resolveSignedUrl(p.coverFaceCropUrl!);
          if (u != null) personCrops[p.id] = u;
        }),
      );

      final faceCrops = <String, String>{};
      await Future.wait(
        data.faces.where((f) => f.faceCropUrl != null).map((f) async {
          final u = await widget.client.resolveSignedUrl(f.faceCropUrl!);
          if (u != null) faceCrops[f.id] = u;
        }),
      );

      final photoIds = data.photos.map((p) => p.id).toList();
      final thumbs = photoIds.isEmpty
          ? <String, String>{}
          : await widget.client.assetUrls(photoIds, variant: "thumb");

      if (!mounted) return;
      setState(() {
        _persons = data.persons;
        _faces = data.faces;
        _photos = data.photos;
        _personCrops.addAll(personCrops);
        _faceCrops.addAll(faceCrops);
        _photoThumbs.addAll(thumbs);
        _loading = false;
      });
    } on ApiException catch (e) {
      _fail("${e.status}: ${e.message}");
    } catch (e) {
      _fail(e.toString());
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _error = msg;
      _loading = false;
    });
  }

  Future<void> _restore(Future<void> Function() call, void Function() drop,
      String label) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await call();
      if (!mounted) return;
      setState(() {
        drop();
        _changed = true;
      });
      messenger.showSnackBar(SnackBar(content: Text("Restored $label")));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text("Couldn't restore: $e")));
    }
  }

  bool get _isEmpty =>
      _persons.isEmpty && _faces.isEmpty && _photos.isEmpty;

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      // Hand the caller `_changed` so the People grid knows to reload.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(title: const Text("Ignored")),
        body: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const ListSkeleton();
    }
    if (_error != null) {
      return ListErrorState(onRetry: _load);
    }
    if (_isEmpty) {
      return const ListEmptyState(
        icon: Icons.visibility_outlined,
        message: "Nothing ignored. Ignored people, faces, and photos show here.",
      );
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        if (_persons.isNotEmpty) ...[
          const _SectionHeader("People"),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: _persons
                .map((p) => _PersonChip(
                      name: p.name ?? "Unnamed",
                      count: p.instanceCount,
                      cropUrl: _personCrops[p.id],
                      onRestore: () => _restore(
                        () => widget.client.setPersonHidden(p.id, false),
                        () => _persons =
                            _persons.where((x) => x.id != p.id).toList(),
                        p.name ?? "person",
                      ),
                    ))
                .toList(),
          ),
        ],
        if (_faces.isNotEmpty) ...[
          const SizedBox(height: 16),
          const _SectionHeader("Faces"),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: _faces
                .map((f) => _FaceChip(
                      cropUrl: _faceCrops[f.id],
                      onRestore: () => _restore(
                        () => widget.client.setFaceHidden(f.id, false),
                        () =>
                            _faces = _faces.where((x) => x.id != f.id).toList(),
                        "face",
                      ),
                    ))
                .toList(),
          ),
        ],
        if (_photos.isNotEmpty) ...[
          const SizedBox(height: 16),
          const _SectionHeader("Photos"),
          ..._photos.map((p) => _PhotoRow(
                filename: p.filename ?? p.id,
                thumbUrl: _photoThumbs[p.id],
                onRestore: () => _restore(
                  () => widget.client.setAssetFacesIgnored(p.id, false),
                  () => _photos = _photos.where((x) => x.id != p.id).toList(),
                  "photo",
                ),
              )),
        ],
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        label,
        style: Theme.of(context)
            .textTheme
            .titleSmall
            ?.copyWith(fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _PersonChip extends StatelessWidget {
  const _PersonChip({
    required this.name,
    required this.count,
    required this.onRestore,
    this.cropUrl,
  });
  final String name;
  final int count;
  final VoidCallback onRestore;
  final String? cropUrl;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      width: 88,
      child: Column(
        children: [
          ClipOval(
            child: SizedBox(
              width: 64,
              height: 64,
              child: cropUrl == null
                  ? Container(
                      color: Colors.black12,
                      child: const Icon(Icons.person),
                    )
                  : CachedNetworkImage(
                      imageUrl: cropUrl!,
                      fit: BoxFit.cover,
                      placeholder: (_, __) => Container(color: Colors.black12),
                      errorWidget: (_, __, ___) => const Icon(Icons.person),
                    ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall,
          ),
          Text(
            "$count",
            style: theme.textTheme.labelSmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          TextButton(
            onPressed: onRestore,
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(0, 28),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: const Text("Restore"),
          ),
        ],
      ),
    );
  }
}

class _FaceChip extends StatelessWidget {
  const _FaceChip({required this.onRestore, this.cropUrl});
  final VoidCallback onRestore;
  final String? cropUrl;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 72,
      child: Column(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: SizedBox(
              width: 64,
              height: 64,
              child: cropUrl == null
                  ? Container(
                      color: Colors.black12,
                      child: const Icon(Icons.face_outlined),
                    )
                  : CachedNetworkImage(
                      imageUrl: cropUrl!,
                      fit: BoxFit.cover,
                      placeholder: (_, __) => Container(color: Colors.black12),
                      errorWidget: (_, __, ___) =>
                          const Icon(Icons.face_outlined),
                    ),
            ),
          ),
          TextButton(
            onPressed: onRestore,
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(0, 28),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: const Text("Restore"),
          ),
        ],
      ),
    );
  }
}

class _PhotoRow extends StatelessWidget {
  const _PhotoRow({
    required this.filename,
    required this.onRestore,
    this.thumbUrl,
  });
  final String filename;
  final VoidCallback onRestore;
  final String? thumbUrl;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: SizedBox(
          width: 48,
          height: 48,
          child: thumbUrl == null
              ? Container(
                  color: Colors.black12,
                  child: const Icon(Icons.image_outlined),
                )
              : CachedNetworkImage(
                  imageUrl: thumbUrl!,
                  fit: BoxFit.cover,
                  placeholder: (_, __) => Container(color: Colors.black12),
                  errorWidget: (_, __, ___) =>
                      const Icon(Icons.broken_image_outlined),
                ),
        ),
      ),
      title: Text(
        filename,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: const Text("All faces ignored"),
      trailing: TextButton(
        onPressed: onRestore,
        child: const Text("Restore"),
      ),
    );
  }
}
