// /export on the phone: the thread goes to the iPhone's share sheet, since a
// phone has no Downloads folder to drop a file in the way the Mac does.

export interface ShareFile { name: string; text: string; type: string }
type Sharer = Pick<Navigator, "share"> & Partial<Pick<Navigator, "canShare">>;

/** Share as a file where the phone allows it, else as plain text. False when the person closed the sheet. */
export async function shareThreadFile(file: ShareFile, title: string, nav: Partial<Sharer> = navigator): Promise<boolean> {
  if (!nav.share) throw new Error("This phone can't share from the app. Export from your Mac instead.");
  const asFile = typeof File === "function" ? new File([file.text], file.name, { type: file.type }) : null;
  const data: ShareData = asFile && nav.canShare?.({ files: [asFile] }) ? { title, files: [asFile] } : { title, text: file.text };
  try {
    await nav.share(data);
    return true;
  } catch (error) {
    // Closing the share sheet isn't a failure.
    if (error instanceof Error && error.name === "AbortError") return false;
    throw error;
  }
}
