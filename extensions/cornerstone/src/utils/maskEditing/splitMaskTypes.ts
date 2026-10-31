export type VolumeComponent = { code: number; voxelCount: number; seedIndex: number };
export type VolumeSplitAnalysis = {
  mask: Uint8Array;
  components: VolumeComponent[];
  ignoredRegions: number;
  ignoredVoxels: number;
};
export type MaskSplitPreview = {
  id: string;
  minimumVoxels: number;
  sliceCount: number;
  ignoredRegions: number;
  ignoredVoxels: number;
  components: (VolumeComponent & { volumeMm3: number | null; keepOriginal: boolean })[];
};
