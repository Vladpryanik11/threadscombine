/** Offers `data` to the browser as a JSON file (indented by 2) through a temporary link. */
export function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click(); // starts the download; the URL is of no use after it
  } finally {
    URL.revokeObjectURL(url);
  }
}
