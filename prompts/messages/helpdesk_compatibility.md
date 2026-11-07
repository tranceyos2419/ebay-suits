# Handling Compatibility Questions

Account: jdm-direct-motors (3Dsellers sellerId 593062)
Automation: hourly scheduled task `jdm-motors-compatibility-replies` (Claude app)

## Manual

Open 3D Seller through the connector.

Select the store jdm-direct-motors.

Go to Helpdesk, then open New Ticket. Work from New Ticket directly; don't wait for tickets to be moved to Motor Low 36H. (Also handle anything that is already in Motor Low 36H.)

Review incoming messages asking about vehicle compatibility.

If the buyer has not provided a VIN or chassis number, reply directly with:

> Please send us your vehicle’s make, model, and year—or preferably its VIN (chassis number)—so we can check whether the parts you’ve purchased fit your vehicle. Providing accurate vehicle information helps us prevent costly mistakes and avoid unnecessary expenses for you.

If the buyer has already provided a VIN or chassis number, check compatibility directly using the MPN shown on the eBay listing page, then reply based on the findings. Only confirm compatibility if it has been verified.

If the buyer asks about shipping, move the conversation directly to Motor Priority 24h.

If the buyer asks what is included with the product, check the MPN on the eBay listing page to verify the package contents before replying.

- If the buyer asks about stock availability, reply: “This item is currently available.”
- If the buyer asks about a specific item without providing an MPN, reply: “Could you please provide the part number (MPN) of the item you’re looking for?”

## Rules added since

- Tell the buyer the truth either way: say it fits only when verified, and say so plainly when the part is not listed for their vehicle.
- Mark the ticket resolved every time we reply (`markResolved: true`). A buyer reply reopens it.
- If we already asked for the VIN and the buyer answered without one, don't ask again; leave the ticket for a person.

## Notes for the 3Dsellers connector

- "Motor Low 36H" and "Motor Priority 24h" are the custom statuses "Motors Low 36h" and "Motors Priority 24h". The connector can filter on them and set them (`get-helpdesk-custom-statuses`: Motors Low 36h = 31285, Motors Priority 24h = 39172), so shipping questions are moved with `set-helpdesk-ticket-status` and `customStatusId` 39172.
- Find buyer questions with `get-helpdesk-tickets` (sellerId 593062, source `regular`, status `new_ticket` plus "Motors Low 36h", `lastMessageAfter`) and keep tickets whose newest message is from the buyer (`buyerMessageDate` equals `lastMessageDate`). New Ticket is the main queue; most of it is automatic "Thank you for your purchase" threads with no buyer message, which are skipped. A buyer reply moves a resolved ticket back to New Ticket.
- Read the MPN with the Browse API (`src/lib/browse_api.ts` → `getLegacyItem`). Our listings have no eBay fitment tables (`check_compatibility` returns error 11505), so check fitment in the genuine parts catalogs.
- Decode US VINs with NHTSA vPIC: `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/<VIN>?format=json`.
- Replies are sent with authorName "Claude connector". Each ticket takes at most 1 reply per minute and 10 per day.
