/** One service's promoted artifact digest, exactly as the candidate's recorded build named it (GY-1844). */
export interface PromotedDigests { sha: string; digests?: readonly { service: string; digest: string }[] | null }
/** One recorded running instance: the service it serves and the digest it was observed running (null when none was recorded). */
export interface RecordedInstance { service: string; instance: string; digest: string | null }
export interface DigestVerification {
  /** `digest`: every promoted service's instances were compared with its promoted digest. `sha-promoted`: the promotion carried no digests — an adapter that cannot deploy by digest — so sha promotion stands and there is nothing to compare. */
  mode: 'digest' | 'sha-promoted';
  verified: boolean;
  /** One entry per failing service, naming it and what ran instead. */
  mismatches: { service: string; detail: string }[];
}

