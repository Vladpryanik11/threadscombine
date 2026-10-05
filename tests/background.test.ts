import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../entrypoints/background';

it('opens the side panel on action click', async () => {
  const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
  (fakeBrowser as any).sidePanel = { setPanelBehavior };
  background.main();
  expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
});
