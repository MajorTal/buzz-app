pub const PROTOCOL_VERSION: u8 = 2;
pub const V2_HEADER_LEN: usize = 8;
pub const FLAG_DTX: u8 = 0x01;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub seq: u16,
    pub ts_48k: u32,
    pub level_dbov: i8,
    pub flags: u8,
}

impl FrameHeader {
    pub fn encode(self) -> [u8; V2_HEADER_LEN] {
        let mut out = [0_u8; V2_HEADER_LEN];
        out[0..2].copy_from_slice(&self.seq.to_be_bytes());
        out[2..6].copy_from_slice(&self.ts_48k.to_be_bytes());
        out[6] = self.level_dbov as u8;
        out[7] = self.flags;
        out
    }

    pub fn parse(bytes: &[u8]) -> Option<(Self, &[u8])> {
        if bytes.len() < V2_HEADER_LEN {
            return None;
        }
        let raw_level = bytes[6] as i8;
        Some((
            Self {
                seq: u16::from_be_bytes([bytes[0], bytes[1]]),
                ts_48k: u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]),
                level_dbov: if (-127..=0).contains(&raw_level) {
                    raw_level
                } else {
                    -127
                },
                flags: bytes[7],
            },
            &bytes[V2_HEADER_LEN..],
        ))
    }
}

pub fn parse_relay_frame(bytes: &[u8]) -> Option<(u8, FrameHeader, &[u8])> {
    let (&peer_index, framed) = bytes.split_first()?;
    let (header, opus) = FrameHeader::parse(framed)?;
    (!opus.is_empty()).then_some((peer_index, header, opus))
}

pub fn audio_level_dbov(samples: &[f32]) -> i8 {
    if samples.is_empty() {
        return -127;
    }
    let mean_square = samples
        .iter()
        .map(|sample| f64::from(*sample).powi(2))
        .sum::<f64>()
        / samples.len() as f64;
    if mean_square <= 0.0 {
        return -127;
    }
    (20.0 * mean_square.sqrt().log10())
        .round()
        .clamp(-127.0, 0.0) as i8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_header_matches_the_deployed_network_byte_order() {
        let header = FrameHeader {
            seq: 0x0102,
            ts_48k: 960,
            level_dbov: -20,
            flags: FLAG_DTX,
        };
        assert_eq!(header.encode(), [1, 2, 0, 0, 3, 192, 236, 1]);

        let mut relay_frame = vec![7];
        relay_frame.extend(header.encode());
        relay_frame.extend([0xaa, 0xbb]);
        assert_eq!(
            parse_relay_frame(&relay_frame),
            Some((7, header, &[0xaa, 0xbb][..]))
        );
    }

    #[test]
    fn relay_frame_requires_an_opus_payload() {
        let mut frame = vec![1];
        frame.extend(
            FrameHeader {
                seq: 0,
                ts_48k: 0,
                level_dbov: -127,
                flags: 0,
            }
            .encode(),
        );
        assert!(parse_relay_frame(&frame).is_none());
    }

    #[test]
    fn level_is_rms_dbov() {
        assert_eq!(audio_level_dbov(&[0.0; 960]), -127);
        assert_eq!(audio_level_dbov(&[1.0; 960]), 0);
        assert_eq!(audio_level_dbov(&[0.1; 960]), -20);
    }
}
