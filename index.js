const Apify = require('apify');

// Usually code should be readable and comprehensive without comments.
// Using comments exceeding 80 cols I explain how I think here and I point out some problems in left in code.
//
// Using request labels, I'll build a processing pipeline, like a simple 3-state automata:
//
// ```
//    (start) -> amz-search-keyword -> amz-extract-desc -> amz-extract-offers -> (write-out)
// ```
//
const amzSearchKeywordLabel = 'amz-search-keyword';
const amzExtractDescriptionLabel = 'amz-extract-desc';
const amzExtractOffersLabel = 'amz-extract-offers';

// I start by putting the starting `URL` into the `requestQueue` with label
// `amz-search-keyword`. For each label defined above, I execute one step of the
// pipeline (as defined in the exercise statement).
//
// - Successful completion of one step results in a transition (see above), by
// enqueuing another request labeled using the next label the state chain.
// - Each step may fail by throwing, that is not in the diagram.
// - The `(write-out)` is not a label. It means we write out the result from the pipeline.
// - The `(start)` is Apify.main() entry-point.
//
// Using a diagram (or other suitable tool) it is easy to comunicate key aspects of algorithms.
//
Apify.main(async () => {
    // Call this point our "`(start)`" state.
    const input = apify.getInput();
    const { keyword } = input;

    if (!keyword || typeof keyword !== 'string' || keyword.length === 0) {
      // Comming from Java: I always check my contract and solve conflicts by fast-failure.
      // Exception handling on upper level has to be reliable. With promises before node 10 or 11 some exceptions flew out of the window.
      throw new Error('Scraper input malformed. Well formed request look like: '
          + '{ keyword: "string" }');
    }

    const requestQueue = await Apify.openRequestQueue();
    requestQueue.addRequest(
      makeRequestForAmazonSearch(keyword, {})
    );

    try {
        const crawler = new Apify.PuppeteerCrawler({
            requestQueue,
            launchPuppeteerOptions: { },
            maxRequestsPerCrawl: 10,
            handlePageFunction: async ({ request, page }) => {
                console.log(`Processing ${request.url}...`);
                switch(request.userData.label) {
                  case amzSearchKeywordLabel:
                    const items = handleRequestForSearchAmazon({ request, page });
                    // An alternative to the Promise.all approch bellow is this more concise sequential code:
                    //
                    // ```
                    //   for (const asin of asins)
                    //     await requestQueue.addRequest({ url: 'https://news.ycombinator.com/' });
                    // ```
                    //
                    await Promise.all(
                      items.map(item => requestQueue.addRequest(
                        makeRequestForExtractDescription(item, request.userData.payload)
                      ))
                    );

                    break;
                  case amzExtractDescriptionLabel:
                    const productDescription = handleRequestForExtractDescription({ request, page });
                    requestQueue.addRequest(
                        makeRequestForExtractOffers(productDescription, request.userData.payload)
                    );
                    break;
                  case amzExtractOffersLabel:
                    const offers = handleRequestForExtractOffers({ request, page });
                    writeOut(offers)
                    break;
                }
            },

            // This function is called if the page processing failed more than maxRequestRetries+1 times.
            handleFailedRequestFunction: async ({ request }) => {
                console.log(`Request ${request.url} failed too many times`);
                await Apify.pushData({
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                });
            },
        });

        // Run the crawler and wait for it to finish.
        await crawler.run();
    } finally {
      console.log('Crawler finished.');
    }

    const makeRequestForAmazonSearch = (keyword, payload) => {
      return {
        url: `https://www.amazon.com/s?k=${keyword}`,
        userData: {
          label: amzSearchKeywordLabel,
          payload: Object.extend(payload, { keyword: keyword })
        }
      };
    }

    const makeRequestForExtractDescription = (item, payload = {}) => {
        return {
            url: item.url,
            userData: {
                label: amzExtractDescriptionLabel,
                payload: Object.extend(payload, {
                    asin: item.asin,
                    itemUrl: item.url,
                }
            }
        };
    }

    const makeRequestForExtractOffers = (payload) => {
        const asin = payload.asin;
        return {
            url: `https://www.amazon.com/gp/offer-listing/${asin}`,
            userData: {
                label: amzExtractOffersLabel,
                payload: payload
            }
        };
    }

    const handleRequestForSearchAmazon =
        ({ request, page }) => await page.$eval('*[data-asin]', el => {
            asin: el.dataset.asin,
            // There are at least 2 tags <a class="a-link-normal"> lading to product description in a product rendering.
            // Pick the one in the text title. This might be improved.
            title: el.querySelector('h2 a.a-link-normal').innerText,
            url: el.querySelector('h2 a.a-link-normal').href
        });

    const handleRequestForExtractDescription =
        aync ({ { request: { userData: { payload } }, page }) => {
            return await page.$$eval('div#productDescription', el => el.outerHTML)
        };

    const handleRequestForExtractOffers =
        async ({ request: { userData: { payload } }, page }) => {
          const pageFunction = offers =>
              offers.map(offer =>
                  ({
                      seller: offer.querySelector('.olpSellerName').innerText,
                      price: offer.querySelector('.olpOfferPrice').innerText,
                      shipping: offer.querySelector('.olpShippingInfo').href,
                  })
              );
          const offers = await page.$$eval('#olpOfferList .olpOffer', pageFunction);

          return offers.map(offer =>
              Object.extend({
                  description: payload.description,
                  title: payload.title,
                  itemUrl: payload.itemUrl,
                  keyword: payload.keyword,
              }, offer)
          );
    }

    const writeOut = (offers) => {
      for (const offer of offers) {
          await Apify.pushData(offer);
      }
    }
});
