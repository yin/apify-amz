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
    const input = {keyword: "asus zenbook"}; // Apify.getInput();
    const {keyword} = input;

    if (!keyword || typeof keyword !== 'string' || keyword.length === 0) {
        // Comming from Java: I always check my contract and solve conflicts by fast-failure.
        // Exception handling on upper level has to be reliable. With promises before node 10 or 11 some exceptions flew out of the window.
        throw new Error('Scraper input malformed. Well formed request look like: '
            + '{ keyword: "string" }' + "\n"
            + 'While we received: ' + JSON.stringify(input));
    }

    const makeRequestForAmazonSearch = (keyword, payload) => {
        return {
            url: `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}`,
            userData: {
                label: amzSearchKeywordLabel,
                payload: Object.assign(payload, {keyword: keyword})
            }
        };
    };

    const makeRequestForExtractDescription = (item, payload = {}) => {
        return {
            url: item.url,
            userData: {
                label: amzExtractDescriptionLabel,
                payload: Object.assign(payload, {
                    asin: item.asin,
                    itemUrl: item.url,
                })
            }
        };
    };

    // Passing `productDescription` explicitly makes this method coupled to the result of method `handleRequestForExtractDescription()`. I'd pass an object and `Object.assign()` it with the payload, but there is little point for an excercise.
    const makeRequestForExtractOffers = (productDescription, payload) => {
        const asin = payload.asin;
        payload.productDescription = productDescription;
        return {
            url: `https://www.amazon.com/gp/offer-listing/${asin}`,
            userData: {
                label: amzExtractOffersLabel,
                payload: payload
            }
        };
    };

    const handleRequestForSearchAmazon =
        async ({request, page}) => await page.$$eval('.s-result-list .s-result-item[data-asin]', els => els.map(el =>
            ({
                asin: el.dataset.asin,
                // There are at least 2 tags <a class="a-link-normal"> lading to product description in a product rendering.
                // Pick the one in the text title. This might be improved.
                title: el.querySelector('h2 .a-link-normal').innerText,
                url: el.querySelector('h2 .a-link-normal').href,
            })
        ));

    const handleRequestForExtractDescription =
        async ({request: {userData: {payload}}, page}) => {
            // Product description requires some additional processing here. We should have define what is expected, e.g. keep text, discard formatting.
            return await page.$$eval('div#productDescription', el => el[0] && el[0].innerHTML || null);
        };

    const handleRequestForExtractOffers =
        async ({request: {userData: {payload}}, page}) => {
            const pageFunction = offers =>
                offers.map(offer =>
                    ({
                        seller: offer.querySelector('.olpSellerName').innerText,
                        price: offer.querySelector('.olpOfferPrice').innerText,
                        shipping: offer.querySelector('.olpShippingInfo').innerText || 'free',
                    })
                );
            const offers = await page.$$eval('#olpOfferList .olpOffer', pageFunction);

            return offers.map(offer =>
                Object.assign({
                    description: payload.productDescription,
                    title: payload.title,
                    itemUrl: payload.itemUrl,
                    keyword: payload.keyword,
                }, offer)
            );
        };

    const writeOut = async (offers) => {
        for (const offer of offers) {
            await Apify.pushData(offer);
        }
    };

    const requestQueue = await Apify.openRequestQueue();
    // I have a question, is `await` needed here? May there be a race condition with crawler ignoring the request if it executes late?
    requestQueue.addRequest(
        makeRequestForAmazonSearch(keyword, {})
    );

    try {
        const crawler = new Apify.PuppeteerCrawler({
            requestQueue,
            launchPuppeteerOptions: {},
            maxRequestsPerCrawl: 256,
            handlePageFunction: async ({request, page}) => {
                console.log(`Processing ${request.url}...`);
                switch (request.userData.label) {
                    case amzSearchKeywordLabel:
                        const items = await handleRequestForSearchAmazon({request, page});
                        // An alternative to the Promise.all approach bellow is this more concise sequential code:
                        //
                        // ```
                        //   for (const item of items)
                        //     await requestQueue.addRequest(...);
                        // ```
                        //
                        await Promise.all(
                            items.map(item => requestQueue.addRequest(
                                makeRequestForExtractDescription(item, request.userData.payload)
                            ))
                        );

                        break;
                    case amzExtractDescriptionLabel:
                        const productDescription = await handleRequestForExtractDescription({request, page});
                        requestQueue.addRequest(
                            makeRequestForExtractOffers(productDescription, request.userData.payload)
                        );
                        break;
                    case amzExtractOffersLabel:
                        const offers = await handleRequestForExtractOffers({request, page});
                        await writeOut(offers);
                        break;
                }
            },

            // This function is called if the page processing failed more than maxRequestRetries+1 times.
            handleFailedRequestFunction: async ({request}) => {
                console.log(`Request ${request.url} failed too many times`);
                await Apify.pushData({
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                });
            },
        });

        await crawler.run();
    } finally {
        // This is how Java guys make sure log massages are coherent.
        console.log('Crawler finished.');
    }
});
