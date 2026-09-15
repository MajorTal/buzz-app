use neteq::{codec::AudioDecoder, AudioPacket, NetEq, NetEqConfig, NetEqError, RtpHeader};

pub const SAMPLE_RATE_HZ: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960;
pub const PLAYOUT_SAMPLES: usize = 480;
const OPUS_PAYLOAD_TYPE: u8 = 111;

struct OpusFrameDecoder {
    inner: opus::Decoder,
    scratch: Vec<f32>,
}

impl OpusFrameDecoder {
    fn new() -> Result<Self, String> {
        Ok(Self {
            inner: opus::Decoder::new(SAMPLE_RATE_HZ, opus::Channels::Mono)
                .map_err(|error| format!("opus decoder: {error}"))?,
            scratch: vec![0.0; SAMPLE_RATE_HZ as usize / 1_000 * 60],
        })
    }
}

impl AudioDecoder for OpusFrameDecoder {
    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE_HZ
    }

    fn channels(&self) -> u8 {
        1
    }

    fn decode(&mut self, encoded: &[u8]) -> Result<Vec<f32>, NetEqError> {
        let count = self
            .inner
            .decode_float(encoded, &mut self.scratch, false)
            .map_err(|error| NetEqError::DecoderError(error.to_string()))?;
        Ok(self.scratch[..count].to_vec())
    }
}

pub struct PeerJitterBuffer(NetEq);

impl PeerJitterBuffer {
    pub fn new(peer_index: u8) -> Result<Self, NetEqError> {
        let mut inner = NetEq::new(NetEqConfig {
            sample_rate: SAMPLE_RATE_HZ,
            channels: 1,
            max_packets_in_buffer: 50,
            min_delay_ms: 40,
            max_delay_ms: 200,
            ..Default::default()
        })?;
        inner.register_decoder(
            OPUS_PAYLOAD_TYPE,
            Box::new(OpusFrameDecoder::new().map_err(NetEqError::DecoderError)?),
        );
        let _ = peer_index;
        Ok(Self(inner))
    }

    pub fn insert(
        &mut self,
        peer_index: u8,
        sequence: u16,
        timestamp: u32,
        opus: &[u8],
    ) -> Result<(), NetEqError> {
        self.0.insert_packet(AudioPacket::new(
            RtpHeader::new(
                sequence,
                timestamp,
                u32::from(peer_index),
                OPUS_PAYLOAD_TYPE,
                false,
            ),
            opus.to_vec(),
            SAMPLE_RATE_HZ,
            1,
            20,
        ))
    }

    pub fn playout(&mut self) -> Result<Vec<f32>, NetEqError> {
        self.0.get_audio().map(|frame| {
            debug_assert_eq!(frame.samples.len(), PLAYOUT_SAMPLES);
            frame.samples
        })
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_neteq_still_keeps_a_ten_millisecond_playout_clock() {
        let mut jitter = PeerJitterBuffer::new(3).expect("jitter buffer");
        let frame = jitter.playout().expect("playout");
        assert_eq!(frame.len(), PLAYOUT_SAMPLES);
    }
}
