import Foundation
import ImageIO
import Vision

enum ESIMQRCodeReaderError: LocalizedError {
    case unreadableImage
    case noActivationCode

    var errorDescription: String? {
        switch self {
        case .unreadableImage: return L10n.tr("无法读取所选图片。")
        case .noActivationCode: return L10n.tr("图片中没有识别到有效的 eSIM 激活二维码。")
        }
    }
}

enum ESIMQRCodeReader {
    static func activationCode(in url: URL) throws -> String {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw ESIMQRCodeReaderError.unreadableImage
        }

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let payloads = (request.results ?? []).compactMap(\.payloadStringValue)
        guard let code = payloads.first(where: { value in
            (try? ESIMActivationCode(rawValue: value)) != nil
        }) else {
            throw ESIMQRCodeReaderError.noActivationCode
        }
        return code
    }
}
