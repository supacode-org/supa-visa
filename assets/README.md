# Assets

`Visa.icon` is the app icon, made in Icon Composer. The PNGs are rendered from it with the `ictool` that ships
inside Icon Composer (part of Xcode), each one at its final size rather than scaled down from a larger render:

| File | Size | Used by |
| --- | --- | --- |
| `assets/icon.png` | 512 | README |
| `public/icon.png` | 192 | favicon and page header |
| `public/apple-touch-icon.png` | 180 | iOS home screen; the corners are filled with the icon's background colour, because iOS draws transparent corners as black |

To render one again after changing the icon:

```bash
"/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool" assets/Visa.icon \
  --export-image --output-file assets/icon.png \
  --platform iOS --rendition Default --width 512 --height 512 --scale 1
```

For `public/apple-touch-icon.png`, render at 180 and fill the transparent corners with `#1e1e1f`.

Nothing in this folder goes into the Docker image.
