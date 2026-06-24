export type SyncStatus = 'uploading' | 'pending' | 'synced' | 'failed';

export interface ImageItem {
  id: string;
  filename: string;
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
  thumbUrl: string;
  webUrl: string;
  description: string | null;
  tags: string[];
  attribution?: string;
  likeCount: number;
  likedByMe: boolean;
  commentCount: number;
  commentedByMe: boolean;
  metadata?: {
    format?: string | null;
    width?: number | null;
    height?: number | null;
    sizeBytes?: number | null;
    uploadedAt?: number | null;
    uploadedDay?: string | null;
    uploadedDaySeq?: number | null;
    exif?: {
      aperture?: string | null;
      shutterSpeed?: string | null;
      iso?: number | string | null;
      focalLength?: string | null;
      meteringMode?: string | null;
      matrixMetering?: string | null;
      spotMetering?: string | null;
      exposureCompensation?: string | null;
      flash?: string | null;
    };
    displayReady?: boolean;
  };
  uploadedAt: number;
  uploadedDay?: string | null;
  uploadedDaySeq?: number | null;
  syncStatus: SyncStatus;
}

export interface ImageListResponse {
  items: ImageItem[];
  nextCursor: number | null;
  total: number;
}

export interface UploadPreview {
  width: number;
  height: number;
  blurDataUrl: string;
}
