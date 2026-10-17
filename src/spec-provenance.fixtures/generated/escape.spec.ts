// replaytest-slug: fixture-escape

declare const page: { getByTestId(testId: string): { click(): Promise<void> } };

export async function useFixture(): Promise<void> {
  await page.getByTestId('recorded-control').click();
  await page.getByTestId('last-mile-control').click(); // replaytest-provenance: last-mile
}
