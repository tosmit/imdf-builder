# IMDF Builder for Microsoft Places

A user-friendly web application to create Indoor Mapping Data Format (IMDF) files for use with Microsoft Places. This tool provides a graphical interface for non-technical users to upload floor plans, place various indoor mapping elements, and generate standards-compliant IMDF files.

## Features

- 🖼️ **Floor Plan Upload**: Upload PDF, image (PNG/JPEG), or SVG files of your floor plans — each level can have its own floor plan
- 🏢 **Interactive Editor**: Visual canvas-based editor for placing indoor mapping elements
- 📍 **IMDF Elements Support**:
  - Building Footprint (polygon drawn over the whole building)
  - Level Footprint (per-level polygon boundary)
  - Units (rooms, offices, conference rooms) — draw as a polygon or place as a rectangle
  - Sections (subdivisions within a level, e.g. corridors, parking areas)
  - Amenities (desks, seating, facilities)
  - Fixtures (walls, windows)
  - Openings (doors, entrances)
  - Levels (floors)
- ✏️ **Polygon Drawing**: Click to place vertices and double-click (or click the first vertex) to close any polygon shape
- 🔴 **Vertex Editing**: Select a polygon and drag its orange vertex handles to reshape it
- 🧲 **Edge Snapping**: Automatically snap to floor-plan lines while drawing or editing — toggle on/off per session
- 🔒 **Shift-Lock**: Hold Shift while drawing lines to constrain to 45° angles
- 💾 **Project Management**: Save and load projects for later editing; per-level floor plan images are saved with the project
- 📦 **Export**: Generate a complete IMDF file package as a ZIP archive (includes `section.geojson` and all other required files)
- 🏷️ **Exchange Room ID**: Optionally set a Microsoft Exchange room identifier on any unit for Places integration
- 🌓 **Dark Mode**: Toggle in the header; remembers your choice and follows your OS preference
- 🐳 **Docker Support**: Easy deployment with Docker and Docker Compose
- 🔢 **Version Display**: App version shown in the header, sourced from `package.json`


<img width="1280" height="720" alt="508439876-18132b6d-a9e5-442c-80ca-4a68871fbd1e" src="https://github.com/user-attachments/assets/d4df6899-b70f-451e-9d73-d1c2b2cf975a" />


## Quick Start

### Using Docker (Recommended)

The easiest way to run the application is using the pre-built Docker image from GitHub Container Registry:

1. **Install Docker Desktop**
   - Download from [docker.com](https://www.docker.com/products/docker-desktop)
   - Install and start Docker Desktop

2. **Run the Application**
   ```bash
   # Using Docker Compose (recommended)
   docker-compose up -d

   # Or using Docker directly
   docker run -d -p 3000:3000 -v $(pwd)/projects:/app/projects -v $(pwd)/uploads:/app/uploads ghcr.io/loryanstrant/imdf-builder-for-places:latest

   # The application will be available at http://localhost:3000
   ```

3. **Stop the Application**
   ```bash
   docker-compose down
   ```

**Note**: The pre-built image is automatically updated from the main branch. If you want to build locally instead, edit `docker-compose.yml` and uncomment the `build: .` line.

#### Configuration (optional)

Copy `.env.example` to `.env` (Docker Compose reads it automatically) to change:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST_PORT` | `3000` | Host port the app is published on — change it if `3000` is already taken. |
| `TZ` | `UTC` | Container timezone, any IANA name (e.g. `Australia/Sydney`). |

```bash
cp .env.example .env
# edit .env, then:
docker-compose up -d
```

### Running Locally (Without Docker)

1. **Prerequisites**
   - Node.js 18 or higher
   - npm (comes with Node.js)

2. **Installation**
   ```bash
   # Clone the repository
   git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
   cd IMDF-Builder-for-Places

   # Install dependencies
   npm install

   # Start the application
   npm start
   ```

3. **Access the Application**
   - Open your browser and navigate to `http://localhost:3000`

### Building Docker Image Locally (Optional)

If you want to build the Docker image yourself instead of using the pre-built one:

```bash
# Clone the repository
git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
cd IMDF-Builder-for-Places

# Build the Docker image
docker build -t imdf-builder .

# Run the container
docker run -d -p 3000:3000 -v $(pwd)/projects:/app/projects -v $(pwd)/uploads:/app/uploads imdf-builder

# Or edit docker-compose.yml to use 'build: .' instead of the image
```

## How to Use

### Step 1: Create a New Project
1. Enter a project name in the "Project Name" field
2. Enter your building name and venue coordinates (latitude, longitude)
3. Click "Save Project" to save your initial setup

### Step 2: Add Levels
1. In the "Levels" section, enter a level name (e.g., "Ground Floor")
2. Enter the level number (0 for ground floor, 1 for first floor, etc.)
3. Click "Add Level"
4. Click on a level in the list to make it active before placing items or uploading a floor plan

### Step 3: Upload a Floor Plan
1. Select a level to make it active
2. Click "Choose File" in the Floor Plan section
3. Select a PDF, image (PNG/JPEG), or SVG file of your floor plan
4. Click "Upload" — the image is stored with that level and reloaded automatically when you switch back to it

> **PDF note**: Only the first page of a PDF is rendered onto the canvas.

### Step 4: Draw Footprints (optional but recommended)
Use the **Footprints** tools to define the physical extents of your building and levels:

- **Draw Building Footprint**: Traces the outer boundary of the whole building. Only one footprint exists; drawing a new one replaces the previous.
- **Draw Level Footprint**: Traces the boundary of the currently-active level. Each level stores its own footprint.

Click to place each vertex, then double-click (or click the first vertex) to close the polygon. Press **Escape** to cancel mid-draw.

### Step 5: Place Items on the Floor Plan
Select a tool from the **Units & Spaces** or **Other** groups:

| Tool | Description |
|------|-------------|
| **Draw Unit (Polygon)** | Click to place vertices; close to create a freeform room/office polygon |
| **Place Unit (Rectangle)** | Single click to drop a rectangle unit |
| **Draw Section** | Freeform polygon for corridors, parking areas, and other level subdivisions |
| **Place Amenity** | Single click to drop a point marker for a desk, seat, or facility |
| **Place Fixture** | Click and drag to draw a wall or window line |
| **Place Opening (Door)** | Click and drag to draw a door or entrance line |
| **Select Mode** | Click to select and move any object |

**Tips:**
- Hold **Shift** while dragging a line to constrain it to 45° increments.
- Enable **Edge Snapping** to have vertices automatically snap to floor-plan lines.
- Select any polygon and drag its orange vertex dots to fine-tune its shape.

### Step 6: Edit Item Properties
1. Switch to **Select Mode**
2. Click on any placed item
3. Edit its properties in the **Selected Item Properties** panel:
   - **Name** — displayed label for the item
   - **Category** — type of space (see category options per item type below)
   - **Exchange Room ID** — (units only) Microsoft Exchange room address for Places integration (e.g. `room.building@contoso.com`)
4. Properties are applied immediately on change, or click **Update Properties**

#### Unit categories
`room`, `office`, `conference`, `seating`, `restroom`, `elevator`, `stairs`, `wall`, `door`, `unspecified`

#### Section categories
`unspecified`, `nonpublic`, `publiccorridor`, `stairway`, `parking`

### Step 7: Export IMDF Files
1. Click the **Export IMDF Files** button in the right sidebar
2. A ZIP file (`imdf-export.zip`) is downloaded containing all required IMDF files:
   - `venue.geojson`
   - `building.geojson`
   - `level.geojson`
   - `unit.geojson`
   - `section.geojson`
   - `amenity.geojson`
   - `fixture.geojson`
   - `opening.geojson`
   - `anchor.geojson`
   - `manifest.json`
   - Additional empty files required by the IMDF spec

### Step 8: Upload to Microsoft Places
1. Extract the downloaded ZIP file
2. Follow Microsoft's documentation to upload the files to Microsoft Places
3. Reference: [Configure Maps in Microsoft Places](https://learn.microsoft.com/en-us/microsoft-365/places/configure-maps-in-places)

## IMDF Compliance

This tool generates files that comply with the IMDF (Indoor Mapping Data Format) specification as required by Microsoft Places. All generated files include:

- Proper GeoJSON structure
- Unique UUIDs for all features
- Required properties for each feature type
- WGS84 coordinate system (latitude/longitude)
- Relationships between features (level references on units, sections, amenities, etc.)

## Project Structure

```
IMDF-Builder-for-Places/
├── server.js              # Express.js backend server
├── public/                # Frontend files
│   ├── index.html        # Main HTML page
│   ├── css/
│   │   └── styles.css    # Application styles
│   └── js/
│       └── app.js        # Application logic
├── uploads/              # Uploaded floor plans (created at runtime)
├── projects/             # Saved projects (created at runtime)
├── package.json          # Node.js dependencies
├── Dockerfile            # Docker configuration
└── docker-compose.yml    # Docker Compose configuration
```

## Technical Details

### Backend (Node.js/Express)
- File upload handling with Multer (PNG, JPEG, PDF, SVG — up to 50 MB)
- Rate limiting on upload and project endpoints
- Project persistence as JSON files
- Path traversal protection on project IDs
- IMDF file generation including `section.geojson`
- ZIP archive creation for exports using Archiver

### Frontend
- HTML5/CSS3/JavaScript (no framework dependencies)
- Fabric.js for canvas-based editing
- PDF.js for rendering PDF floor plans (first page)
- Polygon drawing with click-to-place vertices and double-click-to-close
- Per-vertex editing via draggable orange handle circles
- Edge snapping using an offscreen canvas pixel-sampling approach
- Shift-lock for 45° constrained line drawing
- Dark mode via CSS custom properties and `data-theme` attribute
- Toast notification system for user feedback
- App version read from `package.json` via `/api/version`

### Docker
- Based on Node.js 18 Alpine image
- Lightweight and efficient
- Persistent volumes for projects and uploads
- Available on GitHub Container Registry (GHCR)
- Image: `ghcr.io/loryanstrant/imdf-builder-for-places:latest`

**Available Image Tags:**
- `latest` — Latest build from the main branch
- `main` — Latest build from the main branch (same as `latest`)
- `v*.*.*` — Specific version tags (when releases are created)

**Pulling the Image:**
```bash
# Pull the latest version
docker pull ghcr.io/loryanstrant/imdf-builder-for-places:latest

# Pull a specific version (example)
docker pull ghcr.io/loryanstrant/imdf-builder-for-places:v1.0.0
```

## Browser Compatibility

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Troubleshooting

### Issue: Cannot upload floor plan
- Check file size (max 50 MB)
- Ensure the file is PDF, PNG, JPEG, or SVG format
- For a PDF, only the **first page** is rendered onto the canvas

### Issue: Docker container won't start
- Ensure Docker Desktop is running
- Check if port 3000 is available — or set `HOST_PORT` in `.env` to a free port
- Try `docker-compose down` and `docker-compose up -d`

### Issue: Items not appearing on canvas
- Ensure you've added and selected a level first
- Check that the correct tool is selected

### Issue: Polygon won't close
- Double-click anywhere to close, or click directly on the first (green) vertex dot
- Press **Escape** to cancel the current draw and start over

### Issue: Edge snapping is too aggressive or not working
- Toggle the **Edge Snapping** checkbox in the Place Items panel
- Snapping relies on pixel sampling of the uploaded floor plan; it works best with high-contrast line drawings

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

## References

- [Microsoft Places Documentation](https://learn.microsoft.com/en-us/microsoft-365/places/)
- [Configure Maps in Microsoft Places](https://learn.microsoft.com/en-us/microsoft-365/places/configure-maps-in-places)
- [IMDF Specification](https://register.apple.com/resources/imdf/)
