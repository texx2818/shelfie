# catalogrr

personal media cataloging - movies, music, games — anything you own.

download the zip. run the docker compose.

```bash
docker compose up -d
```
lives at [http://localhost:4120](http://localhost:4120).

## docker-compose
```yaml
# docker-compose.yml
services:
  catalogrr:
    build:
      context: ./backend
    image: ghcr.io/texx2818/catalogrr:latest
    ports:
      - "4120:4120"
    volumes:
      - catalogrr-data:/data
    restart: unless-stopped
    environment:
      - PORT=4120
      - DB_PATH=/data/catalogrr.db

volumes:
  catalogrr-data:
```

open [http://localhost:4120](http://localhost:4120).

## adding items

- **Barcode / ISBN** — type or scan a barcode; Shelfie looks it up in Open Library (books) or UPC Item DB (everything else)
- **Title search** — searches Open Library, OMDb, MusicBrainz, and RAWG depending on the selected type
- **Manual entry** — fill in the form directly
- **CSV import** — bulk-import from a spreadsheet

## csv format

column names are case-insensitive. `title` is the only required field.

| Column | Notes |
|---|---|
| `title` | Required |
| `creator` | Also accepts `author` or `artist` |
| `type` | `book` `movie` `music` `game` `tv` `other` |
| `year` | |
| `barcode` | Also accepts `isbn` |
| `genre` | |
| `format` | e.g. Blu-ray, Vinyl, Hardback |
| `rating` | 1–5 |
| `notes` | |
| `status` | `owned` `wishlist` `lent` `sold` |
| `cover_url` | |

export your library at any time via the **↓ Export CSV** button.
