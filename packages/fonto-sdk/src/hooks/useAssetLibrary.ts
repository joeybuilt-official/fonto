// EP3 per Frame Forge ADR 0035: headless hook for Fonto's asset library.
// Consumers render their own grid (FF uses Rift design system); this hook
// owns data-fetching + state. Defaults to same-origin cookie auth.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
    Asset,
    AssetLibraryFilters,
    AssetLibraryOptions,
    AssetLibraryState,
} from "../types.js";

export function useAssetLibrary(opts: AssetLibraryOptions): AssetLibraryState {
    const base = opts.baseUrl.replace(/\/$/, "");
    const fetcher = opts.fetcher ?? fetch;
    const authToken = opts.authToken;

    const [assets, setAssets] = useState<Asset[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const [filters, setFiltersState] = useState<AssetLibraryFilters>({
        mime: opts.mime,
        subtype: opts.subtype,
    });

    const abortRef = useRef<AbortController | null>(null);

    const queryString = useMemo(() => {
        const params = new URLSearchParams();
        if (filters.mime) params.set("mime", filters.mime);
        if (filters.subtype) params.set("subtype", filters.subtype);
        const q = params.toString();
        return q ? `?${q}` : "";
    }, [filters.mime, filters.subtype]);

    const refresh = useCallback(async () => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setLoading(true);
        setError(null);
        try {
            const headers: Record<string, string> = { Accept: "application/json" };
            if (authToken) headers.Authorization = `Bearer ${authToken}`;
            const res = await fetcher(`${base}/api/v1/assets${queryString}`, {
                headers,
                credentials: authToken ? "omit" : "include",
                signal: ac.signal,
            });
            if (!res.ok) {
                throw new Error(`assets fetch failed: HTTP ${res.status}`);
            }
            const data = (await res.json()) as { assets?: Asset[] } | Asset[];
            const list = Array.isArray(data) ? data : (data.assets ?? []);
            if (!ac.signal.aborted) setAssets(list);
        } catch (err) {
            if (ac.signal.aborted) return;
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            if (!ac.signal.aborted) setLoading(false);
        }
    }, [base, fetcher, authToken, queryString]);

    const setFilters = useCallback((next: AssetLibraryFilters) => {
        setFiltersState((cur) => ({ ...cur, ...next }));
    }, []);

    useEffect(() => {
        void refresh();
        return () => abortRef.current?.abort();
    }, [refresh]);

    return { assets, loading, error, refresh, setFilters, filters };
}
