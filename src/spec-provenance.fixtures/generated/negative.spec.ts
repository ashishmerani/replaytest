// replaytest-slug: fixture-negative

declare const page: { getByTestId(testId: string): { click(): Promise<void> } };

const stringDecoy = "page.getByTestId('unwitnessed-in-string')";
const templateDecoy = `page.getByTestId("unwitnessed-in-template")`;
// page.getByTestId('unwitnessed-in-comment').click();

export async function useFixture(): Promise<void> {
  void stringDecoy;
  void templateDecoy;
  await page.getByTestId("unwitnessed-control").click();
}
