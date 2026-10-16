//! Reads phone picture frames and converts picture pixels to phone points.

pub const MAX_FRAME: usize = 5 * 1024 * 1024;

#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buf.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while self.buf.len() >= 4 {
            let len = u32::from_be_bytes(self.buf[..4].try_into().unwrap()) as usize;
            if len == 0 || len > MAX_FRAME {
                return Err(format!("bad frame length {len}"));
            }
            if self.buf.len() < 4 + len {
                break;
            }
            frames.push(self.buf[4..4 + len].to_vec());
            self.buf.drain(..4 + len);
        }
        Ok(frames)
    }
}

pub fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut i = 2usize;
    loop {
        if *bytes.get(i)? != 0xFF {
            return None;
        }
        let marker = *bytes.get(i + 1)?;
        if marker == 0xFF {
            i += 1;
            continue;
        }
        let len = u16::from_be_bytes(bytes.get(i + 2..i + 4)?.try_into().ok()?) as usize;
        if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
            let height = u16::from_be_bytes(bytes.get(i + 5..i + 7)?.try_into().ok()?);
            let width = u16::from_be_bytes(bytes.get(i + 7..i + 9)?.try_into().ok()?);
            return Some((u32::from(width), u32::from(height)));
        }
        i += 2 + len;
    }
}

pub fn to_points(px: u32, scale: f64) -> f64 {
    px as f64 / scale
}

pub fn to_pixels(pt: f64, scale: f64) -> u32 {
    (pt * scale).round().max(0.0) as u32
}

#[cfg(test)]
pub(crate) fn tiny_jpeg(width: u16, height: u16) -> Vec<u8> {
    let [h1, h0] = height.to_be_bytes();
    let [w1, w0] = width.to_be_bytes();
    vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, h1, h0, w1, w0,
         0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9]
}

#[cfg(test)]
pub(crate) fn framed(jpeg: &[u8]) -> Vec<u8> {
    let mut out = (jpeg.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(jpeg);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_across_reads_come_out_whole() {
        let one = framed(&tiny_jpeg(603, 1311));
        let mut reader = FrameReader::default();
        assert!(reader.push(&one[..3]).unwrap().is_empty());
        assert!(reader.push(&one[3..10]).unwrap().is_empty());
        let frames = reader.push(&one[10..]).unwrap();
        assert_eq!(frames, vec![tiny_jpeg(603, 1311)]);
        let two = [framed(&[1, 2]), framed(&[3])].concat();
        assert_eq!(reader.push(&two).unwrap(), vec![vec![1, 2], vec![3]]);
    }

    #[test]
    fn absurd_frame_lengths_are_refused() {
        assert!(FrameReader::default().push(&[0, 0, 0, 0]).is_err());
        assert!(FrameReader::default().push(&[0xFF, 0xFF, 0xFF, 0xFF]).is_err());
    }

    #[test]
    fn jpeg_size_reads_the_frame_header() {
        assert_eq!(jpeg_size(&tiny_jpeg(603, 1311)), Some((603, 1311)));
        assert_eq!(jpeg_size(b"not a jpeg"), None);
        assert_eq!(jpeg_size(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn pixels_and_points_convert_both_ways() {
        assert_eq!(to_points(150, 1.5), 100.0);
        assert_eq!(to_pixels(99.0, 1.5), 149);
        assert_eq!(to_pixels(-3.0, 1.5), 0);
    }
}
