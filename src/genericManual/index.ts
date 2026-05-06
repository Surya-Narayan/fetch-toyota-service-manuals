import { AxiosResponse } from "axios";
import { client } from "../api/client";
import { access, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import parseToC, { ParsedToC } from "./parseToC";
import { Page } from "playwright";
import { Manual } from "..";

export default async function downloadGenericManual(
  page: Page,
  manualData: Manual,
  path: string
) {
  // download ToC
  let tocReq: AxiosResponse | undefined;
  // BM-prefix manuals on TIS may live at either /bm/ (older Body Manuals) or
  // /cr/ (newer Collision Repair manuals). Try the original type first, then
  // fall back to /cr/ for BM IDs.
  const candidatePaths = [`${manualData.type}/${manualData.id}/toc.xml`];
  if (manualData.type === "bm") {
    candidatePaths.push(`cr/${manualData.id}/toc.xml`);
  }
  for (const candidate of candidatePaths) {
    try {
      console.log(`Downloading table of contents from ${candidate}...`);
      tocReq = await client({
        method: "GET",
        url: candidate,
        // we don't want axios to parse this
        responseType: "text",
      });
      break;
    } catch (e: any) {
      if (e.response && e.response.status === 404) {
        console.log(`  Not found at ${candidate}, trying next...`);
        continue;
      }
      throw new Error(
        `Unknown error getting title XML for manual ${manualData.raw}: ${e}`
      );
    }
  }
  if (!tocReq) {
    throw new Error(
      `Manual ${manualData.id} doesn't appear to exist at any known path-- are you sure the ID is right?`
    );
  }

  const files = parseToC(tocReq.data, manualData.year);

  // write to disk
  console.log("Saving table of contents...");
  await Promise.all([
    writeFile(join(path, "toc-full.xml"), tocReq.data),
    writeFile(
      join(path, "toc-downloaded.json"),
      JSON.stringify(files, null, 2)
    ),
    writeFile(
      join(path, "toc.js"),
      `document.toc = JSON.parse(\`${JSON.stringify(files).replaceAll(
        '\\"',
        ""
      )}\`);`
    ),
  ]);

  console.log("Downloading full manual...");
  await recursivelyDownloadManual(page, path, files);
}

async function recursivelyDownloadManual(
  page: Page,
  path: string,
  toc: ParsedToC
) {
  const exploded = Object.entries(toc);

  for (const explIdx in exploded) {
    const [name, value] = exploded[explIdx];

    if (typeof value === "string") {
      const sanitizedName = name.replace(/\//g, "-");
      const sanitizedPath = `${join(path, sanitizedName)}.pdf`;

      // Resume support: skip if already downloaded
      try {
        await access(sanitizedPath);
        console.log(`Skipping page ${sanitizedName} (already downloaded)`);
        continue;
      } catch {
        // file doesn't exist, proceed to download
      }

      console.log(`Downloading page ${sanitizedName}...`);

      // Toyota TIS serves an HTML wrapper page that redirects to a real PDF.
      // We extract the PDF URL from the HTML and download it directly via HTTP.
      // This is faster, more reliable, and yields a higher-quality PDF than
      // rendering the HTML in Playwright would.
      try {
        const sep = value.includes("?") ? "&" : "?";
        const htmlUrl = `${value}${sep}sisuffix=ff&locale=en&siid=${Date.now()}`;

        // Step 1: fetch the HTML wrapper to find the real PDF URL
        const htmlResp = await client({
          method: "GET",
          url: `https://techinfo.toyota.com${htmlUrl}`,
          responseType: "text",
        });

        // Extract PDF URL from <link rel="pdf" href="..."> or location="..."
        const html = htmlResp.data as string;
        const linkMatch = html.match(/<link[^>]+rel=["']pdf["'][^>]+href=["']([^"']+)["']/i);
        const scriptMatch = html.match(/location\s*=\s*["']([^"']+\.pdf)["']/i);
        const pdfPath = linkMatch?.[1] || scriptMatch?.[1];

        if (!pdfPath) {
          console.error(`Error saving page ${name}: could not find PDF URL in HTML response`);
          continue;
        }

        // Step 2: download the actual PDF as binary
        // The PDF URL also requires the locale query param (same redirect pattern)
        const pdfSep = pdfPath.includes("?") ? "&" : "?";
        const pdfUrl = `https://techinfo.toyota.com${pdfPath}${pdfSep}locale=en`;
        const pdfResp = await client({
          method: "GET",
          url: pdfUrl,
          responseType: "arraybuffer",
        });

        // Sanity-check: real PDFs start with "%PDF"
        const buf = Buffer.from(pdfResp.data as ArrayBuffer);
        if (buf.slice(0, 4).toString() !== "%PDF") {
          console.error(
            `Error saving page ${name}: response is not a PDF (got: ${buf.slice(0, 60).toString()})`
          );
          continue;
        }

        await writeFile(sanitizedPath, buf);
      } catch (e) {
        console.error(`Error saving page ${name}: ${e}`);
        continue;
      }

      // downloaded page, move on
      continue;
    }

    // we're not at the bottom of the tree, continue

    // create folder
    const newPath = join(path, name.replace(/\//g, "-"));
    if (newPath.includes("undefined")) debugger;
    try {
      await mkdir(newPath, { recursive: true });
    } catch (e) {
      if ((e as any).code === "EEXIST") {
        console.log(
          `Not creating folder ${newPath} because it already exists.`
        );
      }
    }

    await recursivelyDownloadManual(page, newPath, value);
  }
}
