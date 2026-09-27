// Public types for @joeybuilt/fonto-sdk consumers.

export type AssetClassification =
    | "photo"
    | "screenshot"
    | "mockup"
    | "logo"
    | "icon"
    | "receipt"
    | "contract"
    | "letter"
    | "report"
    | "form"
    | "document"
    | "scan";

export type AssetProcessingState =
    | "captured"
    | "classified"
    | "extracted"
    | "ready";

export interface Asset {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    description: string | null;
    classification: AssetClassification | string | null;
    processingState: AssetProcessingState | string;
    capturedAt: string | null;
    createdAt: string;
    extractedText?: string | null;
}

export interface AssetLibraryFilters {
    /** MIME prefix (e.g. "image/" or "application/pdf"). Omit for no filter. */
    mime?: string;
    /** Classification subtype (e.g. "photo", "screenshot"). Omit for no filter. */
    subtype?: string;
}

export interface AssetLibraryOptions extends AssetLibraryFilters {
    /**
     * Fonto API base URL — e.g. "https://fonto.example.com" or "" for same-origin.
     * Trailing slash trimmed automatically.
     */
    baseUrl: string;
    /** Optional bearer token for cross-origin calls. Same-origin uses cookies. */
    authToken?: string;
    /** Optional fetch override (for SSR / tests). Defaults to global fetch. */
    fetcher?: typeof fetch;
}

export interface AssetLibraryState {
    assets: Asset[];
    loading: boolean;
    error: Error | null;
    /** Re-fetch with current filters. */
    refresh: () => Promise<void>;
    /** Update filters; triggers a refetch. */
    setFilters: (next: AssetLibraryFilters) => void;
    /** Current filter state (echoed back for controlled UIs). */
    filters: AssetLibraryFilters;
}
