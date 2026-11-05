# Changelog

## v1.0.1, 2026-11-05

- An event page you deleted in Thymer and brought back with Undo was treated as deleted: it stopped following Google, and the event could come back as a second page. Now a restored page syncs like any other.

## v1.0.0, 2026-10-19

First release.

- Two-way sync between Google Calendar and a Thymer collection, with several Google accounts and a rolling sync window (a few days back, a few months ahead).
- Every event is a page you can write in. Your page title stays yours; Google's title lives in its own property.
- The date, Location and My Response go back to Google, and a page with a date and a Calendar becomes a Google event.
- Attendees and organizers link to your people collection, matched by e-mail, then by name.
- Before the first sync, you choose your calendars, where attendees link (a collection you have, a new People collection, or none) and how status is shown. Nothing syncs until you start it.
- Event dates in When (the default) or in Due Date, the name your other collections and the Supertask plugin use. Settings, Sync, Event dates; switching moves every page's date across.
- A page you move to another collection leaves the sync and is never created again; move it back and it follows Google again.
- Cancelled events are marked, never deleted, and can be mapped onto your own status collection.
- Series edits in Google move the existing pages instead of creating copies.
- Google Meet links from the Command Palette, and your personal Zoom room.
- Place suggestions while you type a Location (Geoapify, falling back to OpenStreetMap's Photon).
- Asks Google only for event access and the calendar list. The app is verified by Google.
