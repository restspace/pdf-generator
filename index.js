const chromium = require("@sparticuz/chromium");
const puppeteer = require('puppeteer-core');
const path = require("path");
const fs = require("fs");
const os = require("os");
const AWS = require("@aws-sdk/client-s3");

const temporaryHtmlFile = "pdf.html";
const outputPdfFile = "output.pdf";
chromium.setGraphicsMode = false;
const s3 = new AWS.S3Client({});

async function persistToS3(data, s3Bucket, s3Key) {
  try {
    const command = new AWS.PutObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      Body: data,
      ContentType: "application/pdf",
    });

    await s3.send(command);
  } catch (err) {
    console.log(err);
    return;
  }
}

const extraArgs = [
  '--disable-features=IsolateOrigins',
  '--disable-site-isolation-trials',
  '--autoplay-policy=user-gesture-required',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-domain-reliability',
  '--disable-extensions',
  '--disable-features=AudioServiceOutOfProcess',
  '--disable-gpu',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-setuid-sandbox',
  '--disable-speech-api',
  '--disable-sync',
  '--hide-scrollbars',
  '--ignore-gpu-blacklist',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  '--no-sandbox',
  '--no-zygote',
  '--password-store=basic',
  '--use-gl=swiftshader',
  '--use-mock-keychain'
];

const innerHandler = async (event, context) => {
  const startTime = new Date().getTime();
  const browser = await puppeteer.launch({
    args: [ ...chromium.args, ...extraArgs ],
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
    protocolTimeout: 300000,
    pipe: true,
  });
  console.log("Browser launched: ", new Date().getTime() - startTime);

  let tempPath = '';
  if (!event.url) {
    tempPath = path.resolve(os.tmpdir(), temporaryHtmlFile);
    await new Promise((res, rej) => fs.writeFile(
      tempPath,
      event.data,
      "utf8",
      (err) => {
        console.log('temp file saved: ' + (err ? JSON.stringify(err) : 'ok'));
        if (err) {
          rej(err);
        } else {
          res();
        }
        return;
      }
    ));
  }
  console.log("HTML written: ", new Date().getTime() - startTime);

  const page = await browser.newPage();
  console.log("Page opened: ", new Date().getTime() - startTime);
  const pageUrl = event.url || `file://${tempPath}`;
  await page.goto(pageUrl, { 'waitUntil': 'networkidle0' });
  console.log("NeworkIdle0 in: ", new Date().getTime() - startTime);

  await page.evaluate(() => { window.scrollBy(0, window.innerHeight); });
  console.log("Scrolling done: ", new Date().getTime() - startTime);
  await page.evaluate(async () => {
    const selectors = Array.from(document.querySelectorAll("img"));
    await Promise.all(selectors.map(img => {
      if (img.complete || !img.src) return;
      return new Promise((resolve, reject) => {
        img.addEventListener('load', resolve);
        img.addEventListener('error', reject);
        setTimeout(() => {
          console.log('Image timeout: ', img.src);
          reject();
        }, 6000)
      });
    }));
  });
  console.log("Images loaded: ", new Date().getTime() - startTime);
  //await new Promise(res => setTimeout(() => res(), 20000));

  const args = {
    ...event,
    path: path.resolve(os.tmpdir(), outputPdfFile)
  };
  delete args.data;
  delete args.url;

  await page.pdf(args);
  await browser.close();
  console.log("PDF generated: ", new Date().getTime() - startTime);

  const result = fs.readFileSync(path.resolve(os.tmpdir(), outputPdfFile));
  console.log("PDF read: ", new Date().getTime() - startTime);

  if (event.persisted) {
    await persistToS3(result, event.s3Bucket, event.s3Key);
    return { url: `https://${event.s3Bucket}.s3.eu-west-2.amazonaws.com/${event.s3Key}` };
  } else {
    return { data: result.toString("base64") };
  }
};

exports.handler = async (event, context) => {
  try {
    return await innerHandler(event, context);
  } catch (err) {
    console.log(err);
    return { error: err };
  }
}
