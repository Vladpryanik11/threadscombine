import type { Mock } from 'vitest';
import { downloadJson } from '../../src/ui/download';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let createObjectURL: Mock<typeof URL.createObjectURL>;
let revokeObjectURL: Mock<typeof URL.revokeObjectURL>;

beforeEach(() => {
  createObjectURL = vi.fn<typeof URL.createObjectURL>().mockReturnValue('blob:threadscombine/file-1');
  revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

describe('downloadJson', () => {
  it('clicks a temporary download link to a JSON blob, then revokes the URL and leaves nothing behind', async () => {
    const calls: string[] = [];
    let link: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      link = this;
      calls.push('click');
    });
    revokeObjectURL.mockImplementation(() => calls.push('revoke'));

    downloadJson('backup.json', { a: 1, list: ['б'] });

    expect(link?.download).toBe('backup.json');
    expect(link?.href).toBe('blob:threadscombine/file-1');
    expect(calls).toEqual(['click', 'revoke']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:threadscombine/file-1');
    expect(document.querySelector('a')).toBeNull();

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(JSON.stringify({ a: 1, list: ['б'] }, null, 2));
  });

  it('revokes the URL even when the click throws', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => downloadJson('backup.json', {})).toThrow('blocked');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:threadscombine/file-1');
  });
});
