package tech.nhz.valence.runtime

open class ValenceException(val code: String, message: String) : Exception(message)

class FsException(code: String, message: String) : ValenceException(code, message)

class DatabaseException(code: String, message: String) : ValenceException(code, message)

class PermissionException(code: String, message: String) : ValenceException(code, message)
