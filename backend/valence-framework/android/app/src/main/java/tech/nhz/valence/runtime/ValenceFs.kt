package tech.nhz.valence.runtime

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.Charset

/**
 * Virtual Unix-like tree:
 *   /app    → APK assets at entry dir    (read-only)
 *   /data   → filesDir/valence/data
 *   /cache  → cacheDir/valence
 */
class ValenceFs(private val ctx: Context) {
    private val dataRoot: File = File(ctx.filesDir, "valence/data").apply { mkdirs() }
    private val cacheRoot: File = File(ctx.cacheDir, "valence").apply { mkdirs() }
    private val notes: File = File(dataRoot, "notes").apply { mkdirs() }

    fun getPath(name: String): String = when (name) {
        "app" -> "/app"
        "userData", "documents" -> "/data"
        "notes" -> "/data/notes"
        "cache", "tmp" -> "/cache"
        else -> throw FsException("EINVAL", "unknown path name: $name")
    }

    fun readFile(path: String, encoding: String): String {
        val (root, rel) = resolve(path, write = false)
        if (root == null) {
            val bytes = readAsset(rel)
            return encode(bytes, encoding)
        }
        val f = File(root, rel)
        if (!f.exists() || !f.isFile) throw FsException("ENOENT", "no such file: $path")
        return encode(f.readBytes(), encoding)
    }

    fun writeFile(path: String, data: String, encoding: String): Int {
        val (root, rel) = resolve(path, write = true)
        val f = File(root!!, rel)
        f.parentFile?.mkdirs()
        val bytes = decode(data, encoding)
        f.writeBytes(bytes)
        return bytes.size
    }

    fun readdir(path: String): JSONArray {
        val (root, rel) = resolve(path, write = false)
        val names = JSONArray()
        if (root == null) {
            val prefix = if (rel.isEmpty()) "" else "$rel/"
            listedAssets()
                .filter { it.startsWith(prefix) }
                .map { it.removePrefix(prefix).substringBefore("/") }
                .filter { it.isNotEmpty() }
                .toSortedSet()
                .forEach { names.put(it) }
            return names
        }
        val dir = if (rel.isEmpty()) root else File(root, rel)
        if (!dir.exists()) throw FsException("ENOENT", "no such directory: $path")
        if (!dir.isDirectory) throw FsException("ENOTDIR", path)
        dir.list()?.sorted()?.forEach { names.put(it) }
        return names
    }

    fun mkdir(path: String): String {
        val (root, rel) = resolve(path, write = true)
        File(root!!, rel).mkdirs()
        return normalize(path)
    }

    fun unlink(path: String) {
        val (root, rel) = resolve(path, write = true)
        val f = File(root!!, rel)
        if (!f.exists()) throw FsException("ENOENT", path)
        if (f.isDirectory) throw FsException("EISDIR", "use rmdir")
        f.delete()
    }

    fun rmdir(path: String) {
        val (root, rel) = resolve(path, write = true)
        val f = File(root!!, rel)
        if (!f.exists()) throw FsException("ENOENT", path)
        if (!f.isDirectory) throw FsException("ENOTDIR", path)
        if (f.list()?.isNotEmpty() == true) throw FsException("ENOTEMPTY", path)
        f.delete()
    }

    fun exists(path: String): Boolean = try {
        stat(path)
        true
    } catch (e: FsException) {
        if (e.code == "ENOENT") false else throw e
    }

    fun rename(from: String, to: String) {
        val (fromRoot, fromRel) = resolve(from, write = true)
        val (toRoot, toRel) = resolve(to, write = true)
        val sourceRoot = fromRoot ?: throw FsException("EROFS", from)
        val destinationRoot = toRoot ?: throw FsException("EROFS", to)
        val source = File(sourceRoot, fromRel)
        val destination = File(destinationRoot, toRel)
        if (!source.exists()) throw FsException("ENOENT", from)
        destination.parentFile?.mkdirs()
        if (destination.exists()) throw FsException("EEXIST", to)
        if (sourceRoot.canonicalPath == destinationRoot.canonicalPath && source.renameTo(destination)) return
        if (source.isDirectory) throw FsException("EXDEV", "directory rename across roots is unsupported")
        source.copyTo(destination)
        if (!source.delete()) {
            destination.delete()
            throw FsException("EFAIL", "could not remove source after rename")
        }
    }

    fun stat(path: String): JSONObject {
        val n = normalize(path)
        if (n == "/") {
            return JSONObject()
                .put("path", "/")
                .put("isDirectory", true)
                .put("isFile", false)
                .put("size", 0)
                .put("mtime", 0)
        }
        val (root, rel) = resolve(path, write = false)
        if (root == null) {
            val kids = listedAssets().any { it == rel || it.startsWith("$rel/") }
            if (!kids && readAssetOrNull(rel) == null) throw FsException("ENOENT", path)
            val isFile = readAssetOrNull(rel) != null
            return JSONObject()
                .put("path", n)
                .put("isDirectory", !isFile)
                .put("isFile", isFile)
                .put("size", readAssetOrNull(rel)?.size ?: 0)
                .put("mtime", 0)
        }
        val f = if (rel.isEmpty()) root else File(root, rel)
        if (!f.exists()) throw FsException("ENOENT", path)
        return JSONObject()
            .put("path", n)
            .put("isDirectory", f.isDirectory)
            .put("isFile", f.isFile)
            .put("size", f.length())
            .put("mtime", f.lastModified())
            .put("ctime", f.lastModified())
    }

    fun tree(path: String): JSONArray {
        val out = JSONArray()
        fun add(p: String, dir: Boolean, size: Long, mtime: Long) {
            out.put(
                JSONObject()
                    .put("path", p)
                    .put("type", if (dir) "dir" else "file")
                    .put("size", size)
                    .put("mtime", mtime),
            )
        }
        add("/app", true, 0, 0)
        listedAssets().forEach { rel ->
            add("/app/$rel", false, readAssetOrNull(rel)?.size?.toLong() ?: 0L, 0)
        }
        fun walk(virtual: String, real: File) {
            if (!real.exists()) return
            add(virtual, real.isDirectory, if (real.isFile) real.length() else 0, real.lastModified())
            if (real.isDirectory) {
                real.listFiles()?.sortedBy { it.name }?.forEach { child ->
                    walk("$virtual/${child.name}", child)
                }
            }
        }
        walk("/data", dataRoot)
        walk("/cache", cacheRoot)
        return out
    }

    private fun encode(bytes: ByteArray, encoding: String): String =
        if (encoding == "base64") Base64.encodeToString(bytes, Base64.NO_WRAP)
        else String(bytes, Charset.forName("UTF-8"))

    private fun decode(data: String, encoding: String): ByteArray =
        if (encoding == "base64") Base64.decode(data, Base64.DEFAULT)
        else data.toByteArray(Charset.forName("UTF-8"))

    private fun normalize(path: String): String {
        var s = path.replace('\\', '/')
        if (!s.startsWith("/")) s = "/$s"
        val out = ArrayDeque<String>()
        for (part in s.split('/')) {
            if (part.isEmpty() || part == ".") continue
            if (part == "..") {
                if (out.isEmpty()) throw FsException("EPERM", "path escapes sandbox")
                out.removeLast()
            } else out.addLast(part)
        }
        return "/" + out.joinToString("/")
    }

    /** @return Pair(null, assetRel) for /app, or Pair(realRoot, rel) for writable trees */
    private fun resolve(path: String, write: Boolean): Pair<File?, String> {
        val n = normalize(path)
        val parts = n.trim('/').split('/').filter { it.isNotEmpty() }
        val head = parts.firstOrNull() ?: throw FsException("EINVAL", "refusing filesystem root")
        val rest = parts.drop(1).joinToString("/")
        return when (head) {
            "app" -> {
                if (write) throw FsException("EROFS", "/app is read-only (packaged assets)")
                null to rest
            }
            "data" -> dataRoot to rest
            "cache" -> cacheRoot to rest
            else -> throw FsException("EPERM", "unknown root /$head")
        }
    }

    private fun listedAssets(): List<String> = buildList {
        val base = ValenceBuildConfig.ENTRY.substringBeforeLast('/', "")
        fun rec(prefix: String) {
            val kids = ctx.assets.list(if (prefix.isEmpty()) base else "$base/$prefix") ?: return
            if (kids.isEmpty()) {
                if (prefix.isNotEmpty()) add(prefix)
                return
            }
            for (k in kids) {
                val next = if (prefix.isEmpty()) k else "$prefix/$k"
                rec(next)
            }
        }
        rec("")
    }

    private fun readAsset(rel: String): ByteArray =
        readAssetOrNull(rel) ?: throw FsException("ENOENT", "/app/$rel")

    private fun readAssetOrNull(rel: String): ByteArray? = try {
        val base = ValenceBuildConfig.ENTRY.substringBeforeLast('/', "")
        ctx.assets.open(if (rel.isEmpty()) base else "$base/$rel").use { it.readBytes() }
    } catch (_: Exception) {
        null
    }
}
