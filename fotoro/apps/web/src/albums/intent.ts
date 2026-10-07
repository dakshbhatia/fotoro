import type {FotoroAlbumInvitation} from "@fotoro/contracts/albums-links";
import {IncomingPublicIntent} from "../exchange/sharing";
export class IncomingAlbumIntent extends IncomingPublicIntent<FotoroAlbumInvitation> {}
