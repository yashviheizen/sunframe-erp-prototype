// Uploaded files live in IndexedDB as Blobs so they survive refreshes.
import { createStore, get, set, del, clear } from 'idb-keyval';
import type { FileMeta } from './types';
import { uid } from './format';

const fileStore = createStore('sunframe-files', 'blobs');

export async function storeFile(file: File | Blob, name?: string): Promise<FileMeta> {
  const fileId = 'f_' + uid();
  await set(fileId, file, fileStore);
  return {
    fileId,
    name: name ?? (file as File).name ?? 'file',
    mime: file.type || 'application/octet-stream',
    size: file.size,
  };
}

export async function getFileBlob(fileId: string): Promise<Blob | undefined> {
  return get<Blob>(fileId, fileStore);
}

export async function openFile(meta: FileMeta) {
  const blob = await getFileBlob(meta.fileId);
  if (!blob) throw new Error('File not found in local storage. It may have been cleared by the browser.');
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadFile(meta: FileMeta) {
  const blob = await getFileBlob(meta.fileId);
  if (!blob) throw new Error('File not found in local storage.');
  downloadBlob(blob, meta.name);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function deleteFile(fileId: string) { await del(fileId, fileStore); }
export async function clearFiles() { await clear(fileStore); }
