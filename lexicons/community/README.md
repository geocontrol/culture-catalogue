# Vendored community lexicons

Schemas published by [Lexicon Community](https://lexicon.community),
MIT licensed, copied here so the String can validate records that use
them. **They are not ours — do not edit.** Refresh from the source of
truth with `python scripts/vendor_community_lexicons.py`.

CultureBlocs uses:

- `community.lexicon.calendar.event` — the event record. We publish
  these rather than a CultureBlocs-specific listing type, so a venue's
  nights appear in every calendar app on the network (atmo.rsvp and
  others) instead of only in ours.
- `community.lexicon.calendar.rsvp` — intent to attend. We read these;
  a bead is the complementary past-tense record: an RSVP says "I'm
  going", a bead says "I was here, and this is what it was like".
- `community.lexicon.location.*` — how an event says where it is.
