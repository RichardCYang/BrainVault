const pdfPage = {
  widthMm: 297,
  horizontalMarginMm: 10,
  millimetersPerInch: 25.4,
  cssPixelsPerInch: 96
};

const wideMainContentWidth = 1400;
const legacyPageMaxWidth = 960;
const printableWidth =
  ((pdfPage.widthMm - pdfPage.horizontalMarginMm * 2) / pdfPage.millimetersPerInch) *
  pdfPage.cssPixelsPerInch;

const vulnerableMeasuredPageWidth = wideMainContentWidth;
const correctedMeasuredPageWidth = Math.min(wideMainContentWidth, legacyPageMaxWidth);
const calculateScale = (pageWidth) => Math.min(1, printableWidth / pageWidth);

const vulnerableScale = calculateScale(vulnerableMeasuredPageWidth);
const correctedScale = calculateScale(correctedMeasuredPageWidth);

console.log(JSON.stringify({
  scenario: "full-bleed screen page width leaking into PDF export measurement",
  viewport: {
    mainContentWidth: wideMainContentWidth,
    legacyPageMaxWidth,
    printableWidth: Number(printableWidth.toFixed(4))
  },
  vulnerable: {
    measurementModeAppliedFirst: false,
    measuredPageWidth: vulnerableMeasuredPageWidth,
    scale: Number(vulnerableScale.toFixed(4)),
    unnecessarilyShrinksLegacyWidthContent: vulnerableScale < 1
  },
  fixed: {
    measurementModeAppliedFirst: true,
    measuredPageWidth: correctedMeasuredPageWidth,
    scale: Number(correctedScale.toFixed(4)),
    unnecessarilyShrinksLegacyWidthContent: correctedScale < 1
  }
}, null, 2));
